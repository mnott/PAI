/**
 * follow-reroute.ts — a queued `pai worker run` that is rerouted (reroute.ts) is stopped with SIGTERM while its
 * caller still waits on its stdout. Instead of dying with 143, the process follows the run that took over
 * (status.fallThroughTo, set by rerunOn) and prints that run's result and exit code.
 */

import { readFileSync } from "node:fs";
import { loadStatus, saveStatus, isTerminal, type WorkerStatus } from "../status.js";
import { eventsPath } from "../paths.js";
import { printResult } from "./finalise.js";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export interface FollowDeps {
  load?: (id: string) => WorkerStatus | null;
  /** Poll interval and how long the new run may take to appear (tests shrink both). */
  pollMs?: number;
  appearMs?: number;
}

function lastResultEvent(logDir: string, id: string): { result?: string; [k: string]: unknown } | null {
  let raw: string;
  try {
    raw = readFileSync(eventsPath(logDir, id), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim().startsWith("{")) continue;
    try {
      const e = JSON.parse(lines[i]) as { type?: string };
      if (e.type === "result") return e;
    } catch {
      // a torn line is skipped
    }
  }
  return null;
}

/**
 * Wait for the run that took over from `wid`, print its result in `fmt` and return its exit code.
 * Without a successor in time, one line names the old id and 143 is returned.
 */
export async function followRerouted(logDir: string, wid: string, fmt: "text" | "json" | "stream-json", d: FollowDeps = {}): Promise<number> {
  const load = d.load ?? ((x: string) => loadStatus(logDir, x));
  const pollMs = d.pollMs ?? 500;
  const appearMs = d.appearMs ?? 60_000;
  const wait = () => new Promise((r) => setTimeout(r, pollMs));
  const t0 = Date.now();
  let next: string | undefined;
  while (!(next = load(wid)?.fallThroughTo)) {
    if (Date.now() - t0 > appearMs) {
      process.stderr.write(`pai worker: ${wid} was rerouted (${load(wid)?.rerouted ?? "?"}) but the new run did not start in time\n`);
      return 143;
    }
    await wait();
  }
  process.stderr.write(`pai worker: ${wid} rerouted — following ${next} (${load(wid)?.rerouted ?? ""})\n`);
  for (;;) {
    const st = load(next);
    if (st && isTerminal(st.state)) {
      const rc = st.rc ?? (st.state === "done" ? 0 : 1);
      printResult(fmt, lastResultEvent(logDir, next) as never, rc, logDir, next);
      return rc;
    }
    await wait();
  }
}

/**
 * While the run waits in the queue: a stop signal on a rerouted run is followed, anything else keeps the
 * default (the signal is re-raised). Returns the uninstall for when the run leaves the queue.
 */
export function followRerouteOnSignal(logDir: string, wid: string, fmt: "text" | "json" | "stream-json"): () => void {
  const handlers = SIGNALS.map((sig) => {
    const h = () => {
      const st = loadStatus(logDir, wid);
      if (!st?.rerouted) {
        uninstall();
        process.kill(process.pid, sig);
        return;
      }
      // the killer waits for a terminal status; ours says so and keeps the reroute marker
      st.state = "killed";
      st.rc = 143;
      st.last = `rerouted: ${st.rerouted}`.slice(0, 90);
      saveStatus(logDir, st);
      uninstall();
      void followRerouted(logDir, wid, fmt).then((rc) => process.exit(rc));
    };
    process.once(sig, h);
    return [sig, h] as const;
  });
  function uninstall(): void {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
  return uninstall;
}
