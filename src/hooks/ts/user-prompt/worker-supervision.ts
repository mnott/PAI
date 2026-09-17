#!/usr/bin/env node

/**
 * worker-supervision.ts
 *
 * UserPromptSubmit hook that surfaces worker supervision events into the
 * session that owns the workers. The PAI daemon watches every worker's
 * status file (src/workers/supervision.ts) and appends one JSON line per
 * finished/failed/stalled event to
 * <logDir>/supervision/<claude-session-id>.events. AIBroker pushes the same
 * line into the terminal when it can; this hook is the channel that works
 * without one — on the next prompt, every line the session has not yet seen
 * is injected as context, and the cursor moves past it.
 *
 * Together the two channels replace polling: the orchestrator gets told its
 * worker finished, failed or stalled, and never sleeps to find out.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWorkerSession } from "../lib/worker-session.js";
import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";

interface HookInput {
  session_id?: string;
}

/**
 * Lines this session has already had injected. The count (not a byte offset)
 * is the cursor because the file is append-only by construction; a recreated
 * file simply clamps back to zero and replays its fresh content.
 */
function readCursor(path: string): number {
  try {
    return Math.max(0, Number(readFileSync(path, "utf8").trim()) || 0);
  } catch {
    return 0;
  }
}

function main(): void {
  if (isWorkerSession()) return; // workers supervise nothing

  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  if (!raw.trim()) return;
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return;
  }
  const session = input.session_id;
  if (!session) return;

  // logDir is wherever workers.logDir says (default ~/.claude/logs/workers);
  // a missing or broken workers section means no supervision to surface
  let logDir: string;
  try {
    logDir = workersLogDir(readWorkersSection().workers);
  } catch {
    return;
  }

  const dir = join(logDir, "supervision");
  const eventsPath = join(dir, `${session}.events`);
  const cursorPath = join(dir, `${session}.cursor`);
  if (!existsSync(eventsPath)) return;

  let lines: string[];
  try {
    lines = readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return;
  }
  const fresh = lines.slice(readCursor(cursorPath));
  if (fresh.length === 0) return;

  // events AIBroker already typed into this terminal have a push receipt;
  // this hook is the fallback channel and must not repeat them
  let pushedIds = new Set<string>();
  try {
    pushedIds = new Set(
      readFileSync(join(dir, `${session}.pushed`), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    );
  } catch {
    // no receipts means nothing was pushed, everything surfaces here
  }

  const texts = fresh
    .map((l) => {
      try {
        const ev = JSON.parse(l) as { id?: string; text?: string };
        if (ev.id && pushedIds.has(ev.id)) return null;
        return ev.text ?? null;
      } catch {
        return null;
      }
    })
    .filter((t): t is string => t !== null);
  try {
    writeFileSync(cursorPath, String(lines.length), "utf8");
  } catch {
    // an unwritable cursor only means these lines surface once more
  }
  if (texts.length === 0) return; // damaged lines are consumed, not re-shown

  process.stdout.write(
    `<system-reminder>\nWORKER EVENTS (delivered by the daemon's supervision — no polling needed):\n` +
      texts.join("\n") +
      `\n</system-reminder>\n`
  );
}

main();
