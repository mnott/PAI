/**
 * `pai bench run`: drives bench/evalset.sh and bench/realset.sh over sets and reps for one provider,
 * serially, under a watchdog. Routing is pinned and escalation / quota retry are off in
 * bench/config-eval.template.yaml, so a run never leaves the provider under test.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../module-paths.js";
import { DEFAULT_LIMITS, LogTail, Watchdog, type Verdict } from "./watch.js";

export const SET_NAMES = ["short", "easy", "hard"] as const;

export interface BenchRunOpts {
  provider: string;
  sets: string[];
  reps: number;
  /** Real-task reps (0 = none). */
  real: number;
  key: string;
  /** Results root: <dir>/results, <dir>/work. */
  dir: string;
  /** Minutes one real task may run. */
  realCapMin: number;
  idleSec: number;
  /** An answer file written this many times ends the series (REWRITE). */
  maxWrites: number;
  out: (line: string) => void;
}

export const defaultBenchDir = (): string => process.env.PAI_BENCH_DIR || join(homedir(), ".cache", "pai", "bench");

/** The runs of a series, in order: [script, args]. */
export function planRuns(o: Pick<BenchRunOpts, "provider" | "sets" | "reps" | "real" | "key">): { label: string; script: string; args: string[] }[] {
  const runs: { label: string; script: string; args: string[] }[] = [];
  for (const set of o.sets) {
    for (let rep = 1; rep <= o.reps; rep++) {
      runs.push({ label: `${set} rep${rep}`, script: "evalset.sh", args: [o.provider, "default", set, String(rep), o.key] });
    }
  }
  for (let rep = 1; rep <= o.real; rep++) {
    runs.push({ label: `real rep${rep}`, script: "realset.sh", args: [o.provider, "default", String(rep), o.key] });
  }
  return runs;
}

/** `pai power wait` exists only once the power branch has landed: feature-detect, else no gate. */
export function powerGate(): (() => void) | null {
  const probe = spawnSync("pai", ["power", "--help"], { stdio: "ignore" });
  if (probe.status !== 0) return null;
  return () => void spawnSync("pai", ["power", "wait"], { stdio: "inherit" });
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv, tick: () => Verdict | null): Promise<{ code: number | null; stopped?: Verdict }> {
  return new Promise((resolve) => {
    const child = spawn(script, args, { env, stdio: "ignore", detached: true });
    let stopped: Verdict | undefined;
    const timer = setInterval(() => {
      const v = tick();
      if (!v || stopped) return;
      stopped = v;
      try {
        process.kill(-child.pid!, "SIGTERM"); // the whole group: script, pai worker run and its children
      } catch {
        /* already gone */
      }
    }, 3000);
    child.on("exit", (code) => {
      clearInterval(timer);
      resolve({ code, stopped });
    });
    child.on("error", () => {
      clearInterval(timer);
      resolve({ code: 127, stopped });
    });
  });
}

/** Returns 0 when every run finished, 1 when the watchdog stopped the series or a script failed. */
export async function benchRun(o: BenchRunOpts, logDir = join(homedir(), ".pai", "logs", "workers")): Promise<number> {
  const benchDir = join(packageRoot(import.meta.url), "bench");
  mkdirSync(o.dir, { recursive: true });
  const seriesLog = join(o.dir, `series-${o.key}.log`);
  const log = (line: string): void => {
    const s = `${new Date().toISOString()} ${line}`;
    appendFileSync(seriesLog, s + "\n");
    o.out(s);
  };
  const gate = powerGate();
  log(`series ${o.key}: provider=${o.provider} sets=${o.sets.join(",")} reps=${o.reps} real=${o.real} cap=${o.realCapMin}min power-gate=${gate ? "pai power wait" : "none"} results=${o.dir}`);
  const env: NodeJS.ProcessEnv = { ...process.env, BENCH_DIR: o.dir, BENCH_REAL_MAX_MIN: String(o.realCapMin) };
  delete env.ANTHROPIC_API_KEY;
  const start = Date.now();
  const wd = new Watchdog({ ...DEFAULT_LIMITS, idleMs: o.idleSec * 1000, maxWrites: o.maxWrites }, start);
  const tail = new LogTail(logDir, start, (cwd) => cwd.startsWith(join(o.dir, "work")) || cwd.includes(`${join(".cache", "pai", "realtask-trees")}/${o.key}-`));
  const tick = (): Verdict | null => {
    for (const ev of tail.poll()) {
      const v = wd.feed(ev, Date.now());
      if (v) return v;
    }
    return wd.check(Date.now());
  };
  for (const run of planRuns(o)) {
    gate?.(); // blocks (no ticks run) for as long as the battery pause lasts
    wd.reset(Date.now()); // the wait is not idling: the idle clock restarts after it
    log(`start ${run.label}`);
    const t0 = Date.now();
    const res = await runScript(join(benchDir, run.script), run.args, env, tick);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (res.stopped) {
      log(`STOP ${run.label} after ${secs}s: ${res.stopped.reason} ${res.stopped.detail}; series ended`);
      return 1;
    }
    log(`done ${run.label} in ${secs}s rc=${res.code}`);
    if (res.code !== 0) {
      log(`STOP ${run.label}: script failed (rc=${res.code}); series ended`);
      return 1;
    }
  }
  log(`series ${o.key} complete`);
  return 0;
}
