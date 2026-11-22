/**
 * model-runtimes.ts — the configured start/stop commands of the local model
 * runtimes (config.yaml `models.runtimes.<name>: {start, stop, ready, note}`).
 *
 * Code holds no defaults: the shipped values live in the defaults file
 * (src/config/defaults/config.yaml under models.runtimes) and reach the user
 * through the defaults merge — the user's entries win per key, nothing is
 * ever written into the user's config. A runtime without a configured command
 * shows no button and cannot be started. `autostart: true` additionally lets
 * the PAI daemon start the runtime when it is not up (src/daemon/runtime-autostart.ts);
 * it is never shipped true — only an operator's own config sets it.
 * The commands run detached through a shell,
 * stdout/stderr appended to <PAI home>/logs/local/<runtime>.log; readiness is
 * the configured `ready` URL (a 2xx answers) or command (exit 0 answers),
 * polled until the deadline. Coding tiers keep using local_tiers
 * (`pai worker local`), which this module does not touch.
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, readMainConfigRaw } from "../daemon/config.js";
import { deepMergeConfig, shippedMainDefaults } from "../config/shipped-defaults.js";
import { LOCAL_PROBE_TIMEOUT_MS } from "../utils/timeouts.js";

export interface RuntimeCommands {
  /** shell command that starts the runtime (absent = no start button) */
  start?: string;
  /** shell command that stops it (absent = no stop button) */
  stop?: string;
  /** a URL that must answer 2xx, or a command that must exit 0, to call it up */
  ready?: string;
  /** free text shown on the card */
  note?: string;
  /** the PAI daemon starts this runtime when it is not up (daemon-autostart.ts); default false — never shipped true */
  autostart?: boolean;
  /** exclusive group (e.g. "heavy"): runtimes of one group never run together; start is refused while a peer is up, `switch` swaps them */
  exclusive?: string;
}

/** The other runtimes of `runtime`'s exclusive group; [] when it has none. */
export function exclusivePeers(runtime: string, commands: Record<string, RuntimeCommands>): string[] {
  const g = commands[runtime]?.exclusive;
  if (!g) return [];
  return Object.keys(commands).filter((n) => n !== runtime && commands[n]?.exclusive === g);
}

/** The refusal text when a peer of `runtime`'s group is up (`isUp` = names of up runtimes), else null. */
export function exclusiveRefusalText(runtime: string, commands: Record<string, RuntimeCommands>, isUp: (name: string) => boolean): string | null {
  const peer = exclusivePeers(runtime, commands).find(isUp);
  return peer ? `${peer} is running in exclusive group ${commands[runtime]!.exclusive}; use switch (pai models switch ${runtime})` : null;
}

/** The `models.runtimes` block: the shipped defaults deep-merged UNDER the
 *  user's config (the user's entries win per key); {} when unset or unreadable. */
export function readRuntimeCommands(configPath: string = ""): Record<string, RuntimeCommands> {
  try {
    const raw = configPath ? readMainConfigRaw(configPath) : readMainConfigRaw();
    const merged = deepMergeConfig(
      (shippedMainDefaults().models as { runtimes?: unknown } | undefined)?.runtimes as Record<string, unknown> ?? {},
      (raw.models as { runtimes?: unknown } | undefined)?.runtimes as Record<string, unknown> ?? {}
    );
    const block = merged;
    if (!block || typeof block !== "object" || Array.isArray(block)) return {};
    const out: Record<string, RuntimeCommands> = {};
    for (const [name, v] of Object.entries(block as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const e = v as Record<string, unknown>;
      const cmd: RuntimeCommands = {};
      if (typeof e.start === "string" && e.start.trim()) cmd.start = e.start;
      if (typeof e.stop === "string" && e.stop.trim()) cmd.stop = e.stop;
      if (typeof e.ready === "string" && e.ready.trim()) cmd.ready = e.ready;
      if (typeof e.note === "string" && e.note.trim()) cmd.note = e.note;
      if (e.autostart === true) cmd.autostart = true;
      if (typeof e.exclusive === "string" && e.exclusive.trim()) cmd.exclusive = e.exclusive.trim();
      if (cmd.start || cmd.stop || cmd.ready || cmd.note || cmd.autostart || cmd.exclusive) out[name] = cmd;
    }
    return out;
  } catch {
    return {};
  }
}

/** The log file of a runtime's start/stop output: <PAI home>/logs/local/<runtime>.log. */
export function runtimeLogFile(home: string, runtime: string): string {
  return join(home, "logs", "local", `${runtime}.log`);
}

/** The argv of a configured command: a bare `docker model run` starts the runner's default model. */
export function runtimeOpArgv(cmd: string, model?: string): string[] {
  const argv = cmd.split(/\s+/).filter(Boolean);
  if (model && /(^|\s)model(\s|$)/.test(argv.join(" ")) && !argv.includes(model)) argv.push(model);
  return argv;
}

export interface RuntimeOpDeps {
  /** shell run (stop commands); resolves when the process exits */
  runShell: (cmd: string, logPath: string, timeoutMs?: number) => Promise<{ code: number | null }>;
  /** detached long-running shell run (start commands): returns at once; `exit` settles only if the child ends */
  spawnDetached: (cmd: string, logPath: string) => { exit: Promise<{ code: number | null }> };
  /** a ready URL answered 2xx */
  getUrl: (url: string) => Promise<boolean>;
  /** a ready command: resolves its exit code */
  runCmd: (cmd: string, timeoutMs?: number) => Promise<number | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const RUNTIME_READY_TIMEOUT_MS = 120_000;
export const RUNTIME_READY_POLL_MS = 2_000;
/** A ready probe answers within one poll-ish window; a stop command within half a minute. */
export const RUNTIME_PROBE_TIMEOUT_MS = 10_000;
export const RUNTIME_STOP_TIMEOUT_MS = 30_000;
/** Exit code reported for a stop command that was killed on timeout. */
export const RUNTIME_TIMEOUT_CODE = 124;

const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
};

/** The production deps: one shell run through a detached child, output appended to the runtime's log. */
export const liveRuntimeOpDeps: RuntimeOpDeps = {
  runShell(cmd, logPath, timeoutMs = RUNTIME_STOP_TIMEOUT_MS) {
    return new Promise((resolve) => {
      mkdirSync(dirname(logPath), { recursive: true });
      const fd = openSync(logPath, "a");
      appendFileSync(fd, `\n$ ${cmd}\n`, "utf8");
      const child = spawn(cmd, { shell: true, detached: true, stdio: ["ignore", fd, fd] });
      child.unref();
      const timer = setTimeout(() => {
        appendFileSync(fd, `\n[timed out after ${timeoutMs} ms]\n`, "utf8");
        killGroup(child.pid);
        closeFd(fd);
        resolve({ code: RUNTIME_TIMEOUT_CODE });
      }, timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(timer);
        closeFd(fd);
        resolve({ code });
      });
      child.on("error", () => {
        clearTimeout(timer);
        closeFd(fd);
        resolve({ code: null });
      });
    });
  },
  spawnDetached(cmd, logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, "a");
    appendFileSync(fd, `\n$ ${cmd}\n`, "utf8");
    const child = spawn(cmd, { shell: true, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    // the child holds its own copy of the log fd; the parent's is closed at once
    closeFd(fd);
    const exit = new Promise<{ code: number | null }>((resolve) => {
      child.on("exit", (code) => resolve({ code }));
      child.on("error", () => resolve({ code: null }));
    });
    return { exit };
  },
  async getUrl(url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) });
      return r.ok;
    } catch {
      return false;
    }
  },
  runCmd(cmd, timeoutMs = RUNTIME_PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const child = spawn(cmd, { shell: true, detached: true, stdio: "ignore" });
      const timer = setTimeout(() => {
        killGroup(child.pid);
        resolve(null);
      }, timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const closeFd = (fd: number): void => {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
};

/** Is `ready` a URL (http/https) or a command? */
export const readyIsUrl = (ready: string): boolean => /^https?:\/\//i.test(ready.trim());

/** Poll the runtime's readiness until it answers or the deadline passes. */
export async function waitReady(
  ready: string,
  deps: RuntimeOpDeps,
  timeoutMs = RUNTIME_READY_TIMEOUT_MS,
  pollMs = RUNTIME_READY_POLL_MS,
  /** true = give up now (the start command died) */
  abort: () => boolean = () => false
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    if (abort()) return false;
    const ok = readyIsUrl(ready) ? await deps.getUrl(ready) : (await deps.runCmd(ready)) === 0;
    if (ok) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(pollMs);
  }
}

/** One runtime op (start or stop): the configured command only, output to the runtime's log.
 *  A start then waits for the configured readiness. Refuses a runtime or op with no configured command. */
export async function runRuntimeOp(
  runtime: string,
  op: "start" | "stop",
  commands: Record<string, RuntimeCommands>,
  deps: RuntimeOpDeps,
  home: string,
  opts: { model?: string; readyTimeoutMs?: number } = {}
): Promise<{ ok: boolean; message: string }> {
  const cmd = commands[runtime];
  if (!cmd || !cmd[op]) return { ok: false, message: `no ${op} command configured for ${runtime} (models.runtimes.${runtime}.${op})` };
  const argv = runtimeOpArgv(cmd[op]!, opts.model);
  const logPath = runtimeLogFile(home, runtime);
  if (op === "stop") {
    const { code } = await deps.runShell(argv.join(" "), logPath);
    return { ok: code === 0 || code === null, message: `${runtime} stopped${code ? ` (exit ${code})` : ""} — ${logPath}` };
  }
  // start: the command is usually a server that never exits, so it is spawned, not awaited;
  // an exit before ready is a failure (exit 0 only when ready then still answers, as a launcher that daemonizes)
  let exitCode: number | null | undefined;
  try {
    deps.spawnDetached(argv.join(" "), logPath).exit.then(({ code }) => void (exitCode = code));
  } catch (e) {
    return { ok: false, message: `${runtime} start failed: ${e instanceof Error ? e.message : String(e)}; see ${logPath}` };
  }
  const died = (): boolean => exitCode !== undefined && exitCode !== 0;
  const diedMsg = (): string => `${runtime} start exited (${exitCode ?? "signal"}); see ${logPath}`;
  if (cmd.ready) {
    const up = await waitReady(cmd.ready, deps, opts.readyTimeoutMs, undefined, died);
    if (died()) return { ok: false, message: diedMsg() };
    return up ? { ok: true, message: `${runtime} up (${cmd.ready})` } : { ok: false, message: `${runtime} not ready after ${Math.round((opts.readyTimeoutMs ?? RUNTIME_READY_TIMEOUT_MS) / 1000)} s; see ${logPath}` };
  }
  return { ok: true, message: `${runtime} started — ${logPath}` };
}

/** The embedding consumer's runtime name: ollama for the ollama backend, else the in-process runtime. */
export function embeddingRuntimeName(): string {
  try {
    return loadConfig().embedding.backend === "ollama-f16" ? "ollama" : "pai";
  } catch {
    return "pai";
  }
}

/** Marker of a runtime stopped on purpose (`pai models stop`): <PAI home>/logs/local/<runtime>.stopped. Only an explicit start clears it. */
export const runtimeStoppedFile = (home: string, runtime: string): string => join(home, "logs", "local", `${runtime}.stopped`);
export const markRuntimeStopped = (home: string, runtime: string): void => {
  mkdirSync(dirname(runtimeStoppedFile(home, runtime)), { recursive: true });
  writeFileSync(runtimeStoppedFile(home, runtime), new Date().toISOString() + "\n");
};
export const clearRuntimeStopped = (home: string, runtime: string): void => rmSync(runtimeStoppedFile(home, runtime), { force: true });
export const isRuntimeStopped = (home: string, runtime: string): boolean => existsSync(runtimeStoppedFile(home, runtime));

/** Workers a `switch` parked, per runtime they were served by: <PAI home>/logs/local/switch-parked.json ({runtime: [worker ids]}). A later switch back to that runtime resumes exactly these. */
export const switchParkedFile = (home: string): string => join(home, "logs", "local", "switch-parked.json");
export function readSwitchParked(home: string): Record<string, string[]> {
  try {
    const j = JSON.parse(readFileSync(switchParkedFile(home), "utf8")) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(j)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    return out;
  } catch {
    return {};
  }
}
export function writeSwitchParked(home: string, parked: Record<string, string[]>): void {
  const live = Object.fromEntries(Object.entries(parked).filter(([, v]) => v.length));
  mkdirSync(dirname(switchParkedFile(home)), { recursive: true });
  writeFileSync(switchParkedFile(home), JSON.stringify(live) + "\n");
}
