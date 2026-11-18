/**
 * low-priority-keeper.ts — the daemon keeps listed background apps at background CPU priority.
 *
 * 2026-11-18 13:07: after a restart seaf-daemon (the Seafile sync client) ran at ~90–100% for
 * minutes doing its startup scan of all libraries, and it does the same after every PAI merge or
 * release, which rewrites files in a synced library. `taskpolicy -b -p <pid>` puts a process at
 * background priority (scheduler pri 31 -> 4) at once, but that is lost when the client restarts —
 * so the daemon re-applies it.
 *
 * Config: workers.lowPriority.processes in config.yaml — a list of EXACT process names
 * (matched with `pgrep -x`, never patterns), default empty. Every 60 s the keeper looks each
 * name up, reads its scheduler priority (`ps -o pri=`, background is < BACKGROUND_PRI_MAX = 10)
 * and applies `taskpolicy -b -p <pid>` only where it is not yet at background priority. Each
 * change is logged once per pid; a process it cannot change (owned by root, gone mid-apply) is
 * skipped with one log line for that pid too. The state file <PAI home>/low-priority.json backs
 * the "low priority:" line in `pai daemon status`.
 *
 * All three commands run async (execFile): nothing here touches the event loop synchronously,
 * and no sudo is needed — taskpolicy on one's own processes needs none.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";

export interface LowPriorityConfig {
  enabled: boolean;
  /** Exact process names to keep at background priority (`pgrep -x`, never patterns). Default []. */
  processes: string[];
  /** Seconds between passes. Default 60. */
  intervalSecs: number;
}

export const LOW_PRIORITY_DEFAULTS: LowPriorityConfig = { enabled: true, processes: [], intervalSecs: 60 };

/** `workers.lowPriority` from the main config's workers section. */
export function lowPriorityConfig(workers: unknown): LowPriorityConfig {
  const b = ((workers as { lowPriority?: Record<string, unknown> } | undefined)?.lowPriority ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof b.enabled === "boolean" ? b.enabled : LOW_PRIORITY_DEFAULTS.enabled,
    processes: Array.isArray(b.processes) ? b.processes.filter((x): x is string => typeof x === "string") : LOW_PRIORITY_DEFAULTS.processes,
    intervalSecs: typeof b.intervalSecs === "number" && (b.intervalSecs as number) > 0 ? (b.intervalSecs as number) : LOW_PRIORITY_DEFAULTS.intervalSecs,
  };
}

/** Scheduler priorities below this are background-class: `taskpolicy -b` lands a process at 4
 *  (and macOS can push it to 0 under thermal pressure); normal processes sit at 31+. */
export const BACKGROUND_PRI_MAX = 10;

export const isBackgroundPri = (pri: number): boolean => pri < BACKGROUND_PRI_MAX;

/** The pids `pgrep -x` printed, one per line. */
export function parsePgrep(text: string): number[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(Number);
}

/** The pri `ps -o pri= -p <pid>` printed, or undefined when the pid is gone / unreadable. */
export function parsePsPri(text: string): number | undefined {
  const m = /^\s*(\d+)\s*$/.exec(text);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// State machine (pure)
// ---------------------------------------------------------------------------

/** What one pid's pass decided. */
export type KeeperAction = "already-background" | "lowered" | "skipped";

export interface KeeperPidState {
  pri: number;
  /** Set once this keeper run acted on the pid (lowered or skipped): each change gets exactly one log line. */
  logged: boolean;
  /** True when the apply failed (root-owned, gone): the pid stays reported at its real priority. */
  skipped?: boolean;
}

/** Live pids by exact process name, as this pass found them. */
export type KeeperFound = Map<string, number[]>;

export interface KeeperState {
  /** name → pid → its state. A pid that disappears drops out here and in the status file alike. */
  seen: Map<string, Map<number, KeeperPidState>>;
}

export const freshKeeperState = (): KeeperState => ({ seen: new Map() });

export interface KeeperDeps {
  /** `pgrep -x <name>`: the live pids of that exact name, one per line. */
  pgrep: (name: string) => Promise<string>;
  /** `ps -o pri= -p <pid>`: the scheduler priority, whitespace-padded. */
  psPri: (pid: number) => Promise<string>;
  /** `taskpolicy -b -p <pid>`: background priority; rejects when the process cannot be changed. */
  taskpolicy: (pid: number) => Promise<void>;
  log: (line: string) => void;
  write: (status: LowPriorityStatus) => void;
  now: () => number;
}

/** The status file's shape, one entry per tracked pid. */
export interface LowPriorityPid {
  pid: number;
  pri: number;
  state: "background" | "skipped";
}
export interface LowPriorityStatus {
  at: string;
  processes: string[];
  pids: Record<string, LowPriorityPid[]>;
}

/** One pass over the configured names; mutates `state`, logs each change once per pid. */
export async function lowPriorityKeeperTick(cfg: LowPriorityConfig, state: KeeperState, d: KeeperDeps): Promise<LowPriorityStatus> {
  const found: KeeperFound = new Map();
  if (cfg.enabled) {
    for (const name of cfg.processes) {
      let out = "";
      try {
        out = await d.pgrep(name); // exact names only, never patterns
      } catch {
        /* not running right now: nothing to track */
      }
      found.set(name, parsePgrep(out));
    }
  }
  const pids: Record<string, LowPriorityPid[]> = {};
  for (const [name, list] of found) {
    let m = state.seen.get(name);
    if (!m) state.seen.set(name, (m = new Map()));
    const rows: LowPriorityPid[] = [];
    pids[name] = rows;
    for (const pid of list) {
      let st = m.get(pid);
      if (!st) m.set(pid, (st = { pri: NaN, logged: false }));
      let pri: number | undefined;
      try {
        pri = parsePsPri(await d.psPri(pid));
      } catch {
        /* unreadable this pass: the next one decides */
      }
      if (pri === undefined) continue; // gone between pgrep and ps
      st.pri = pri;
      if (isBackgroundPri(pri)) {
        rows.push({ pid, pri, state: "background" });
        continue; // already background: never touched again
      }
      if (!st.logged) {
        st.logged = true;
        try {
          await d.taskpolicy(pid);
          st.skipped = false;
          d.log(`low priority: ${name} pid ${pid} set to background (pri ${pri})`);
          rows.push({ pid, pri: BACKGROUND_PRI_MAX - 1, state: "background" }); // lowered this pass: it is background now
          continue;
        } catch (e) {
          // cannot change it (root-owned, or gone mid-apply): skipped, logged once for this pid
          st.skipped = true;
          d.log(`low priority: ${name} pid ${pid} skipped — cannot change (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      rows.push({ pid, pri: st.pri, state: "skipped" });
    }
    // a pid that is gone drops out of the bookkeeping (and with it the status file)
    for (const pid of [...m.keys()]) if (!list.includes(pid)) m.delete(pid);
    if (m.size === 0) state.seen.delete(name);
  }
  const status: LowPriorityStatus = { at: new Date(d.now()).toISOString(), processes: [...cfg.processes], pids };
  d.write(status);
  return status;
}

// ---------------------------------------------------------------------------
// Live deps and status file
// ---------------------------------------------------------------------------

const statusFile = (): string => paiHomePath("low-priority.json");

export function readLowPriority(): LowPriorityStatus | null {
  try {
    return JSON.parse(readFileSync(statusFile(), "utf8")) as LowPriorityStatus;
  } catch {
    return null;
  }
}

/** `pai daemon status`: one line per tracked pid — "low priority: seaf-daemon (pid N, background)". */
export function lowPriorityStatusLine(s: LowPriorityStatus | null): string | null {
  if (!s) return null;
  const parts: string[] = [];
  for (const name of s.processes ?? []) {
    for (const p of s.pids?.[name] ?? []) parts.push(`${name} (pid ${p.pid}, ${p.state})`);
  }
  if (!parts.length) return null;
  return `Low priority: ${parts.join(", ")}`;
}

function run(argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export function liveLowPriorityDeps(): KeeperDeps {
  return {
    pgrep: (name) => run(["pgrep", "-x", name]),
    psPri: (pid) => run(["ps", "-o", "pri=", "-p", String(pid)]),
    taskpolicy: async (pid) => void (await run(["taskpolicy", "-b", "-p", String(pid)])),
    log: (l) => process.stderr.write(`[pai-daemon] ${l}\n`),
    write: (s) => {
      try {
        mkdirSync(join(statusFile(), ".."), { recursive: true });
        writeFileSync(statusFile(), JSON.stringify(s), "utf8");
      } catch {
        /* the status file is a courtesy */
      }
    },
    now: () => Date.now(),
  };
}

/** Start the keeper: one pass at boot, then every intervalSecs. Config read once — a change needs a daemon restart. */
export function startLowPriorityKeeper(
  cfg: LowPriorityConfig = lowPriorityConfig(undefined),
  deps: KeeperDeps = liveLowPriorityDeps(),
  tickMs = (cfg.intervalSecs || LOW_PRIORITY_DEFAULTS.intervalSecs) * 1000
): void {
  if (!cfg.processes.length) return; // nothing listed: the keeper sleeps entirely
  const state = freshKeeperState();
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void lowPriorityKeeperTick(cfg, state, deps)
      .catch((e) => deps.log(`low priority keeper tick error: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(tick, 5_000); // let the sync clients finish their own startup before the first pass
  if (first.unref) first.unref();
  const timer = setInterval(tick, tickMs);
  if (timer.unref) timer.unref();
  deps.log(`Low priority keeper: ${cfg.processes.join(", ")} (every ${Math.round(tickMs / 1000)}s)`);
}
