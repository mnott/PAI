/**
 * follow-reroute.ts — a queued run that the escalation (or /cloud, `pai worker reroute`) moves to another
 * provider keeps its original `pai worker run` process: instead of dying with the kill's SIGTERM, it
 * follows the restart to its end and emits the restart's result as its own, so a caller that waits on the
 * original command gets the answer (worker_id = the new id, worker_ids = [old, new], exit code = the restart's).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTerminal, loadStatus, saveStatus, type WorkerStatus } from "../status.js";

export interface FollowDeps {
  logDir: string;
  /** Poll step (tests pass a small one). */
  stepMs?: number;
  /** How long to wait for the restart to be announced. */
  announceTimeoutMs?: number;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/** Where the restart's stdout goes (reroute.ts defaultSpawn). */
export const rerouteOutPath = (logDir: string, oldId: string): string => join(logDir, "runs", `reroute-${oldId}.out`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The last line of `text` that is a JSON object, parsed; null when none. */
function lastJsonObject(text: string): Record<string, unknown> | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const v = JSON.parse(lines[i]) as unknown;
      if (v && typeof v === "object") return v as Record<string, unknown>;
    } catch {
      /* not the payload */
    }
  }
  return null;
}

/**
 * Follow the restart of `old` to the end: print the reroute line, wait for the new run to finish, emit its result.
 * Returns the exit code (the restart's); null when the restart never appeared.
 */
export async function followReroute(old: WorkerStatus, d: FollowDeps): Promise<number | null> {
  const step = d.stepMs ?? 500;
  const out = d.out ?? ((s: string) => void console.log(s));
  const err = d.err ?? ((s: string) => void process.stderr.write(`${s}\n`));
  const deadline = Date.now() + (d.announceTimeoutMs ?? 120_000);
  let next: WorkerStatus | null = null;
  while (!next) {
    const to = loadStatus(d.logDir, old.id)?.fallThroughTo;
    if (to) next = loadStatus(d.logDir, to);
    if (next) break;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
  err(`rerouted to ${next.provider} as ${next.id}`);
  let cur: WorkerStatus = next;
  while (!isTerminal(cur.state)) {
    await sleep(step);
    cur = loadStatus(d.logDir, next.id) ?? cur;
  }
  const rc = cur.rc ?? (cur.state === "done" ? 0 : 1);
  const file = rerouteOutPath(d.logDir, old.id);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (old.outputFormat === "json") {
    const payload = lastJsonObject(text);
    const ids = Array.isArray(payload?.worker_ids) ? (payload?.worker_ids as string[]) : [next.id];
    out(JSON.stringify({ ...(payload ?? { is_error: true, result: "no result event", rc }), worker_id: next.id, worker_ids: [old.id, ...ids.filter((x) => x !== old.id)] }));
  } else if (text.trim()) {
    out(text.trimEnd());
  }
  return rc;
}

/**
 * While `run` waits in the queue: a SIGTERM that comes from a reroute (the status carries `rerouted`) makes
 * this process the restart's follower, any other SIGTERM ends it as before. `aborted()` tells the queue loop to stop.
 * Returns the disposer and the abort probe.
 */
export function guardQueuedRun(logDir: string, wid: string, deps: { exit?: (rc: number) => void } = {}): { dispose: () => void; aborted: () => boolean } {
  let aborted = false;
  const exit = deps.exit ?? ((rc: number) => process.exit(rc));
  const onTerm = (): void => {
    const st = loadStatus(logDir, wid);
    if (!st?.rerouted) {
      exit(143);
      return;
    }
    aborted = true;
    // the kill waits for a terminal status; writing it here keeps the kill from escalating to SIGKILL
    st.state = "killed";
    st.rc = 143;
    st.last = `rerouted: ${st.rerouted}`;
    saveStatus(logDir, st);
    void followReroute(st, { logDir }).then((rc) => exit(rc ?? 143));
  };
  process.on("SIGTERM", onTerm);
  return { dispose: () => process.off("SIGTERM", onTerm), aborted: () => aborted };
}
