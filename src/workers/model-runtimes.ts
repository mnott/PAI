/**
 * model-runtimes.ts — the configured start/stop commands of the local model
 * runtimes (config.yaml `models.runtimes.<name>: {start, stop, ready, note}`)
 * and the one-time migration that seeds them.
 *
 * Code holds no defaults: a runtime without a configured command shows no
 * button and cannot be started. The commands run detached through a shell,
 * stdout/stderr appended to <PAI home>/logs/local/<runtime>.log; readiness is
 * the configured `ready` URL (a 2xx answers) or command (exit 0 answers),
 * polled until the deadline. Coding tiers keep using local_tiers
 * (`pai worker local`), which this module does not touch.
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, readMainConfigRaw, writeMainConfigRaw } from "../daemon/config.js";
import { paiHomePath } from "../config/pai-home.js";

export interface RuntimeCommands {
  /** shell command that starts the runtime (absent = no start button) */
  start?: string;
  /** shell command that stops it (absent = no stop button) */
  stop?: string;
  /** a URL that must answer 2xx, or a command that must exit 0, to call it up */
  ready?: string;
  /** free text shown on the card */
  note?: string;
}

/** The `models.runtimes` block of config.yaml; {} when unset or unreadable. */
export function readRuntimeCommands(configPath: string = ""): Record<string, RuntimeCommands> {
  try {
    const raw = configPath ? readMainConfigRaw(configPath) : readMainConfigRaw();
    const block = (raw.models as { runtimes?: unknown } | undefined)?.runtimes;
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
      if (cmd.start || cmd.stop || cmd.ready || cmd.note) out[name] = cmd;
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
  /** detached shell run; resolves when the process exits */
  runShell: (cmd: string, logPath: string) => Promise<{ code: number | null }>;
  /** a ready URL answered 2xx */
  getUrl: (url: string) => Promise<boolean>;
  /** a ready command: resolves its exit code */
  runCmd: (cmd: string) => Promise<number | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const RUNTIME_READY_TIMEOUT_MS = 120_000;
export const RUNTIME_READY_POLL_MS = 2_000;

/** The production deps: one shell run through a detached child, output appended to the runtime's log. */
export const liveRuntimeOpDeps: RuntimeOpDeps = {
  runShell(cmd, logPath) {
    return new Promise((resolve) => {
      mkdirSync(dirname(logPath), { recursive: true });
      const fd = openSync(logPath, "a");
      appendFileSync(fd, `\n$ ${cmd}\n`, "utf8");
      const child = spawn(cmd, { shell: true, detached: true, stdio: ["ignore", fd, fd] });
      child.unref();
      child.on("exit", (code) => {
        closeFd(fd);
        resolve({ code });
      });
      child.on("error", () => {
        closeFd(fd);
        resolve({ code: null });
      });
    });
  },
  async getUrl(url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return r.ok;
    } catch {
      return false;
    }
  },
  runCmd(cmd) {
    return new Promise((resolve) => {
      const child = spawn(cmd, { shell: true });
      child.on("exit", (code) => resolve(code));
      child.on("error", () => resolve(null));
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
export async function waitReady(ready: string, deps: RuntimeOpDeps, timeoutMs = RUNTIME_READY_TIMEOUT_MS, pollMs = RUNTIME_READY_POLL_MS): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
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
  const { code } = await deps.runShell(argv.join(" "), logPath);
  if (op === "stop") return { ok: code === 0 || code === null, message: `${runtime} stopped${code ? ` (exit ${code})` : ""} — ${logPath}` };
  if (code !== null && code !== 0) return { ok: false, message: `${runtime} start exited (${code}); see ${logPath}` };
  if (cmd.ready) {
    const up = await waitReady(cmd.ready, deps, opts.readyTimeoutMs);
    return up ? { ok: true, message: `${runtime} up (${cmd.ready})` } : { ok: false, message: `${runtime} not ready after ${Math.round((opts.readyTimeoutMs ?? RUNTIME_READY_TIMEOUT_MS) / 1000)} s; see ${logPath}` };
  }
  return { ok: true, message: `${runtime} started — ${logPath}` };
}

// ---------------------------------------------------------------------------
// One-time migration: seed models.runtimes for ollama and docker-model-runner
// ---------------------------------------------------------------------------

/** The values the migration writes when the key is absent (printed in the commit message). */
export const RUNTIME_SEED: Record<string, RuntimeCommands> = {
  ollama: {
    start: "ollama serve",
    stop: 'kill $(lsof -nP -iTCP:11434 -sTCP:LISTEN -t)',
    ready: "http://127.0.0.1:11434/api/tags",
    note: "PAI's embedding backend runs here",
  },
  "docker-model-runner": {
    start: "docker model run",
    stop: "docker model unload",
    ready: "docker model status",
    note: "idle loads a model on the first request",
  },
};

export interface RuntimeSeedResult {
  added: string[];
  skipped: string[];
  wrote: boolean;
}

/** Writes models.runtimes entries for the seed runtimes into the user config when absent.
 *  An existing models.runtimes block (even a partial one) is left untouched; `dryRun` only reports. */
export function seedRuntimeCommands(opts: { dryRun?: boolean; configPath?: string } = {}): RuntimeSeedResult {
  const raw = opts.configPath ? readMainConfigRaw(opts.configPath) : readMainConfigRaw();
  const models = (raw.models ?? {}) as Record<string, unknown>;
  const existing = (models.runtimes ?? {}) as Record<string, unknown>;
  const added: string[] = [];
  const skipped: string[] = [];
  const next = { ...existing };
  for (const [name, cmd] of Object.entries(RUNTIME_SEED)) {
    if (existing[name] !== undefined) {
      skipped.push(name);
      continue;
    }
    next[name] = cmd;
    added.push(name);
  }
  if (!added.length) return { added, skipped, wrote: false };
  if (!opts.dryRun) {
    models.runtimes = next;
    raw.models = models;
    if (opts.configPath) writeMainConfigRaw(raw, opts.configPath);
    else writeMainConfigRaw(raw);
  }
  return { added, skipped, wrote: !opts.dryRun };
}

/** The daemon-side one-time hook: seed when the block is absent, never throw past the log line. */
export function ensureRuntimeCommandsSeeded(): void {
  try {
    const home = process.env.PAI_HOME || paiHomePath();
    if (existsSync(runtimeLogFile(home, ".seeded"))) return;
    const r = seedRuntimeCommands();
    if (r.wrote) appendFileSync(runtimeLogFile(home, ".seeded"), `models.runtimes seeded: ${r.added.join(", ")}\n`, "utf8");
  } catch (e) {
    process.stderr.write(`[pai] models.runtimes seed skipped: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** The embedding consumer's runtime name: ollama for the ollama backend, else the in-process runtime. */
export function embeddingRuntimeName(): string {
  try {
    return loadConfig().embedding.backend === "ollama-f16" ? "ollama" : "pai";
  } catch {
    return "pai";
  }
}
