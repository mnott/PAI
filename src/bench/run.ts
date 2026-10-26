/**
 * `pai bench run`: drives bench/evalset.sh and bench/realset.sh over sets and reps for one provider,
 * serially, under a watchdog. Routing is pinned and escalation / quota retry are off in
 * bench/config-eval.template.yaml, so a run never leaves the provider under test.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKER_TOOLS } from "../workers/run/argv.js";
import { packageRoot } from "../module-paths.js";
import { onboardingForRun, renderOnboarding } from "./onboarding.js";
import { DEFAULT_LIMITS, LogTail, Watchdog, type Verdict } from "./watch.js";

export const SET_NAMES = ["short", "easy", "hard"] as const;

export interface BenchRunOpts {
  provider: string;
  sets: string[];
  reps: number;
  /** Real-task reps (0 = none). */
  real: number;
  key: string;
  /** --allowedTools of the eval-set runs; "real" = what a production worker gets. */
  tools?: string;
  /** Results root: <dir>/results, <dir>/work. */
  dir: string;
  /** Minutes one real task may run. */
  realCapMin: number;
  idleSec: number;
  /** An answer file written this many times ends the series (REWRITE). */
  maxWrites: number;
  out: (line: string) => void;
}

export const EVAL_TOOLS = "Read,Write";

/** The eval-set tool list: "real" is the production worker default; ToolSearch is never added. */
export const resolveTools = (t?: string): string => (!t ? EVAL_TOOLS : t === "real" ? DEFAULT_WORKER_TOOLS : t);

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

const KILL_GRACE_MS = 5000;

/** SIGTERM the whole process group, SIGKILL it after the grace period if anything is left. */
function killGroup(pid: number, graceMs: number): void {
  try {
    process.kill(-pid, "SIGTERM"); // the whole group: script, pai worker run and its children
  } catch {
    return; // already gone
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* group gone */
    }
  }, graceMs).unref();
}

export function runScript(script: string, args: string[], env: NodeJS.ProcessEnv, tick: () => Verdict | null, graceMs = KILL_GRACE_MS): Promise<{ code: number | null; stopped?: Verdict }> {
  return new Promise((resolve) => {
    const child = spawn(script, args, { env, stdio: "ignore", detached: true });
    let stopped: Verdict | undefined;
    const sigs = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    // a stopped bench process must leave nothing running: the detached group would otherwise outlive it
    const onSignal = (sig: NodeJS.Signals): void => {
      for (const s of sigs) process.removeListener(s, onSignal);
      if (child.pid) killGroup(child.pid, graceMs);
      setTimeout(() => process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGHUP" ? 1 : 15)), graceMs + 200);
    };
    for (const s of sigs) process.on(s, onSignal);
    const done = (): void => {
      clearInterval(timer);
      for (const s of sigs) process.removeListener(s, onSignal);
    };
    const timer = setInterval(() => {
      const v = tick();
      if (!v || stopped) return;
      stopped = v;
      if (child.pid) killGroup(child.pid, graceMs);
    }, 3000);
    child.on("exit", (code) => {
      done();
      resolve({ code, stopped });
    });
    child.on("error", () => {
      done();
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
  const tools = resolveTools(o.tools);
  log(`series ${o.key}: provider=${o.provider} sets=${o.sets.join(",")} tools=${tools} reps=${o.reps} real=${o.real} cap=${o.realCapMin}min power-gate=${gate ? "pai power wait" : "none"} results=${o.dir}`);
  const env: NodeJS.ProcessEnv = { ...process.env, BENCH_DIR: o.dir, BENCH_TOOLS: tools, BENCH_REAL_MAX_MIN: String(o.realCapMin) };
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
  // onboarding: the anti-pattern firings of this provider's model during the series, and a suggested
  // `pai antipatterns set ... --model` line per behaviour pattern that fired >= 5 times. Never applied here.
  try {
    for (const line of renderOnboarding(onboardingForRun(o.provider, start))) log(line);
  } catch {
    /* the summary is advisory; a broken firing log must not fail the series */
  }
  return 0;
}
