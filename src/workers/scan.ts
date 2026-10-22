/**
 * scan.ts — the security scan a finished worker gets.
 *
 * `pai audit scan` is the interactive face; this is the automatic one: when
 * a run ends, its own event transcript is scanned with the rules module and
 * the per-severity counts go on the status (`findings`), shown by `ps` and
 * `replay` only when something hit. Best effort throughout — a scan must
 * never fail or slow the worker's end path.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scanTranscript, type Finding } from "../audit/scan.js";
import { loadRules, userRuleDirs } from "../hooks/ts/lib/rules/load.js";
import { eventsPath } from "./paths.js";
import { type WorkerStatus, saveStatus } from "./status.js";

export interface ScanCounts {
  block: number;
  confirm: number;
  warn: number;
}

/** Per-severity counts of findings; zero counts when there are none. */
export function scanCounts(findings: Finding[]): ScanCounts {
  const c: ScanCounts = { block: 0, confirm: 0, warn: 0 };
  for (const f of findings) c[f.severity as keyof ScanCounts]++;
  return c;
}

/** "scan: 1 block, 2 warn" over the non-zero severities; "" when nothing hit. */
export function scanLine(c: ScanCounts | undefined | null): string {
  if (!c) return "";
  const parts = (["block", "confirm", "warn"] as const).filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`);
  return parts.length ? `scan: ${parts.join(", ")}` : "";
}

/**
 * The run's Claude Code transcript: the session file under the project dir
 * when it exists, else any project dir holding the session id. null when the
 * run never recorded a session.
 */
export function claudeSessionTranscript(sessionId: string, cwd: string, home = homedir()): string | null {
  const projects = join(home, ".claude", "projects");
  const own = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (existsSync(own)) return own;
  try {
    for (const d of readdirSync(projects)) {
      const p = join(projects, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {
    // no projects dir
  }
  return null;
}

/**
 * Scan a finished run's transcript and put the counts on its status. The
 * worker's own event mirror is scanned; when the run also recorded a Claude
 * session, that transcript is scanned too (it carries the full tool results
 * the event mirror may trim). Never throws.
 */
export async function scanWorkerRun(
  logDir: string,
  status: WorkerStatus,
  opts: { cwd?: string; home?: string } = {}
): Promise<ScanCounts | null> {
  try {
    const paths: string[] = [];
    const events = eventsPath(logDir, status.id);
    if (existsSync(events)) paths.push(events);
    if (status.claudeSession) {
      const t = claudeSessionTranscript(status.claudeSession, status.cwd, opts.home);
      if (t) paths.push(t);
    }
    if (!paths.length) return null;
    const { rules } = loadRules(userRuleDirs(opts.cwd ?? status.cwd));
    const findings: Finding[] = [];
    for (const p of paths) findings.push(...(await scanTranscript(p, rules)));
    const counts = scanCounts(findings);
    status.findings = counts;
    saveStatus(logDir, status);
    return counts;
  } catch {
    // the scan is a report on the run, never a reason the run ends badly
    return null;
  }
}
