/**
 * local-tiers.ts — one local model server at a time, chosen by tier.
 *
 * `pai worker local <tier>` stops every running serve_patched server and
 * starts the tier's model; `off` stops all; `status` reports what is up.
 * Tiers are config, not code: `local_tiers:` and `local_launcher:` in
 * workers.yaml. A tier names a worker provider (so port and served model
 * name default to that provider's url and default model).
 *
 * This never touches worker routing (`pai worker use` does that).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { paiHomePath } from "../config/pai-home.js";
import { expandHome } from "./config.js";

export class LocalTierError extends Error {}

export interface LocalLauncher {
  python: string;
  script: string;
  /** Flags shared by every tier, as one shell-split string. */
  flags: string[];
  /** Chat-template kwargs JSON (thinking off by default). */
  templateKwargs: string;
  /** Environment for the server process. */
  env: Record<string, string>;
  /** Process-name fragment that identifies a running server. */
  processMatch: string;
  /** Memory kept free when starting an instance, GB. */
  reserveGb: number;
}

export const DEFAULT_MAX_INSTANCES = 4;
export const DEFAULT_RESERVE_GB = 4;

export type LocalEngine = "vllm-mlx" | "strata" | "script";

export interface LocalTier {
  tier: string;
  engine: LocalEngine;
  provider: string;
  /** Button / status text; the tier name when the config gives none. */
  label: string;
  /** Memory the model needs, GB (cockpit button + confirm text). */
  memoryGb?: number;
  /** vllm-mlx: model path; a `*` path segment is expanded against the directory. "" for other engines. */
  model: string;
  /** Model name the server answers with; "" when neither the tier nor its provider names one. */
  served: string;
  /** Base port: instance 1 prefers it, later copies get the next free port. */
  port: number;
  flags: string[];
  /** Most simultaneous copies. Default 4; a script engine defaults to 1 (the script may hardcode its port) unless the config says otherwise. */
  maxInstances: number;
  /** strata: Strata server JSON. */
  config?: string;
  /** strata: python that runs serve/server.py. */
  python?: string;
  /** strata: directory holding serve/server.py (cwd of the start). */
  strataDir?: string;
  /** strata: the engine executable named by the config (a child of server.py). */
  exe?: string;
  /** script: the start script, run detached. */
  start?: string;
}

export interface LocalConfig {
  launcher: LocalLauncher;
  tiers: Record<string, LocalTier>;
}

export const DEFAULT_COMMON_FLAGS =
  "--host 127.0.0.1 --continuous-batching --enable-prefix-cache --cache-memory-mb 8000 " +
  "--gpu-memory-utilization 0.30 --chunked-prefill-tokens 4096 --max-num-seqs 3 " +
  "--max-request-tokens 131072 --max-tokens 32768 --enable-auto-tool-choice " +
  "--tool-call-parser qwen3_coder --reasoning-parser qwen3";

/** The python Strata's own venv carries (what the live server.py process runs). */
export function defaultStrataPython(home = homedir()): string {
  return join(home, "strata/.venv/bin/python");
}

export function defaultLauncher(): LocalLauncher {
  const home = homedir();
  return {
    python: join(home, ".local/share/uv/tools/vllm-mlx/bin/python"),
    script: join(home, ".local/share/vllm-mlx-serve/serve_patched_fold_text.py"),
    flags: DEFAULT_COMMON_FLAGS.split(/\s+/),
    templateKwargs: '{"enable_thinking": false}',
    env: { PF_FORCE_TEXT: "1" },
    processMatch: "serve_patched",
    reserveGb: DEFAULT_RESERVE_GB,
  };
}

function str(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v === "") throw new LocalTierError(`${what}: must be a non-empty string`);
  return v;
}

function flagList(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  const s = str(v, what);
  return s ? s.split(/\s+/) : [];
}

/**
 * Parse the local_launcher / local_tiers keys of a workers.yaml root.
 * `providerUrls`/`providerModels` supply the port and served-name fallbacks.
 */
export function parseLocalConfig(
  root: Record<string, unknown>,
  providers: Record<string, { url?: string; model?: string }>,
): LocalConfig {
  const launcher = defaultLauncher();
  const lr = root.local_launcher;
  if (lr !== undefined && lr !== null) {
    if (typeof lr !== "object" || Array.isArray(lr)) throw new LocalTierError("local_launcher: must be a mapping");
    const l = lr as Record<string, unknown>;
    const python = str(l.python, "local_launcher.python");
    const script = str(l.script, "local_launcher.script");
    if (python) launcher.python = expandHome(python);
    if (script) launcher.script = expandHome(script);
    if (l.flags !== undefined) launcher.flags = flagList(l.flags, "local_launcher.flags");
    const tk = str(l.template_kwargs, "local_launcher.template_kwargs");
    if (tk) launcher.templateKwargs = tk;
    const pm = str(l.process_match, "local_launcher.process_match");
    if (pm) launcher.processMatch = pm;
    if (l.reserve_gb !== undefined) {
      const r = Number(l.reserve_gb);
      if (!(r >= 0)) throw new LocalTierError("local_launcher.reserve_gb: must be a non-negative number");
      launcher.reserveGb = r;
    }
    if (l.env && typeof l.env === "object") {
      launcher.env = Object.fromEntries(Object.entries(l.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    }
  }

  const tiers: Record<string, LocalTier> = {};
  const tr = root.local_tiers;
  if (tr !== undefined && tr !== null) {
    if (typeof tr !== "object" || Array.isArray(tr)) throw new LocalTierError("local_tiers: must be a mapping");
    for (const [name, raw] of Object.entries(tr as Record<string, unknown>)) {
      const where = `local_tiers.${name}`;
      if (!raw || typeof raw !== "object") throw new LocalTierError(`${where}: must be a mapping`);
      const t = raw as Record<string, unknown>;
      const provider = str(t.provider, `${where}.provider`);
      if (!provider) throw new LocalTierError(`${where}.provider: required`);
      const engine = (str(t.engine, `${where}.engine`) ?? "vllm-mlx") as LocalEngine;
      if (engine !== "vllm-mlx" && engine !== "strata" && engine !== "script") {
        throw new LocalTierError(`${where}.engine: must be vllm-mlx, strata or script, got "${engine}"`);
      }
      const model = str(t.model, `${where}.model`);
      if (engine === "vllm-mlx" && !model) throw new LocalTierError(`${where}.model: required`);
      const p = providers[provider];
      let port = t.port === undefined ? undefined : Number(t.port);
      if (port === undefined && p?.url) {
        const m = /:(\d+)(?:\/|$)/.exec(p.url);
        if (m) port = Number(m[1]);
      }
      if (port === undefined || !Number.isInteger(port) || port <= 0) {
        throw new LocalTierError(`${where}.port: missing and not derivable from provider "${provider}"`);
      }
      const served = str(t.served, `${where}.served`) ?? p?.model;
      if (engine === "vllm-mlx" && !served) {
        throw new LocalTierError(`${where}.served: missing and provider "${provider}" has no default model`);
      }
      const mem = t.memoryGb === undefined ? undefined : Number(t.memoryGb);
      if (mem !== undefined && !(mem > 0)) throw new LocalTierError(`${where}.memoryGb: must be a positive number`);
      const maxRaw = t.maxInstances ?? t.max_instances;
      const maxInstances = maxRaw === undefined ? (engine === "script" ? 1 : DEFAULT_MAX_INSTANCES) : Number(maxRaw);
      if (!Number.isInteger(maxInstances) || maxInstances < 1) throw new LocalTierError(`${where}.maxInstances: must be a positive integer`);
      const tier: LocalTier = {
        tier: name,
        engine,
        provider,
        label: str(t.label, `${where}.label`) ?? name,
        ...(mem !== undefined ? { memoryGb: mem } : {}),
        model: model ? expandHome(model) : "",
        served: served ?? "",
        port,
        flags: flagList(t.flags, `${where}.flags`),
        maxInstances,
      };
      if (engine === "strata") {
        const config = str(t.config, `${where}.config`);
        if (!config) throw new LocalTierError(`${where}.config: required for engine strata`);
        tier.config = expandHome(config);
        tier.python = expandHome(str(t.python, `${where}.python`) ?? defaultStrataPython());
        const info = strataInfo(tier.config);
        tier.strataDir = info.dir;
        if (info.exe) tier.exe = info.exe;
      } else if (engine === "script") {
        const start = str(t.start, `${where}.start`);
        if (!start) throw new LocalTierError(`${where}.start: required for engine script`);
        tier.start = expandHome(start);
      }
      tiers[name] = tier;
    }
  }
  return { launcher, tiers };
}

/**
 * Strata directory and engine exe of a Strata server config: the config's own
 * `cwd`, else the nearest parent of its `exe` that holds serve/server.py, else
 * ~/strata-020.
 */
export function strataInfo(configPath: string, home = homedir()): { dir: string; exe?: string } {
  const fallback = join(home, "strata-020");
  let exe: string | undefined;
  let cwd: string | undefined;
  try {
    const j = JSON.parse(readFileSync(configPath, "utf8")) as { exe?: unknown; cwd?: unknown };
    if (typeof j.exe === "string") exe = j.exe;
    if (typeof j.cwd === "string") cwd = j.cwd;
  } catch {
    /* unreadable config: the start fails loudly on its own */
  }
  if (cwd && existsSync(join(cwd, "serve/server.py"))) return { dir: cwd, exe };
  if (exe) {
    for (let d = dirname(exe); d !== dirname(d); d = dirname(d)) {
      if (existsSync(join(d, "serve/server.py"))) return { dir: d, exe };
    }
  }
  return { dir: cwd ?? fallback, exe };
}

/** Read the local config from a workers.yaml file. */
export function readLocalConfig(yamlPath: string): LocalConfig {
  let root: Record<string, unknown> = {};
  if (existsSync(yamlPath)) {
    const doc = parse(readFileSync(yamlPath, "utf8"));
    if (doc && typeof doc === "object") root = doc as Record<string, unknown>;
  }
  const providers: Record<string, { url?: string; model?: string }> = {};
  const pr = root.providers;
  if (pr && typeof pr === "object") {
    for (const [name, raw] of Object.entries(pr as Record<string, unknown>)) {
      const p = (raw ?? {}) as { url?: unknown; models?: { default?: unknown } };
      providers[name] = {
        url: typeof p.url === "string" ? p.url : undefined,
        model: typeof p.models?.default === "string" ? p.models.default : undefined,
      };
    }
  }
  return parseLocalConfig(root, providers);
}

/** Expand `*` path segments to the first (sorted) existing entry. Unresolvable → input unchanged. */
export function resolveModelPath(pattern: string): string {
  if (!pattern.includes("*")) return pattern;
  const segs = pattern.split("/");
  let cur = segs[0] === "" ? "/" : segs[0];
  for (const seg of segs.slice(1)) {
    if (!seg.includes("*")) {
      cur = join(cur, seg);
      continue;
    }
    const re = new RegExp("^" + seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    let hit: string | undefined;
    try {
      hit = readdirSync(cur).filter((e) => re.test(e)).sort()[0];
    } catch {
      return pattern;
    }
    if (!hit) return pattern;
    cur = join(cur, hit);
  }
  return cur;
}

function shq(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface StartPlan {
  env: Record<string, string>;
  argv: string[];
  /** Working directory of the start, when it is not the caller's. */
  cwd?: string;
  logPath: string;
  /** Give up waiting for the port after this long. */
  readyMs: number;
  /** Shell rendering of the above, log redirect included. */
  line: string;
}

/** Log of instance n of a provider; n=1 keeps the bare `<provider>.log`. */
export function logPathFor(provider: string, n = 1): string {
  return paiHomePath("logs", "local", n <= 1 ? `${provider}.log` : `${provider}-${n}.log`);
}

const VLLM_READY_MS = 10 * 60 * 1000;
const STRATA_READY_MS = 5 * 60 * 1000;

/**
 * Start plan of instance `n` of a model on `port` (default: the base port).
 * The port goes to every engine: `--port` for vllm-mlx and Strata, `PORT` env
 * plus a trailing `--port` for a script. Log is `<provider>-<n>.log` (n>=2).
 */
export function planStart(cfg: LocalConfig, tier: LocalTier, port = tier.port, n = 1): StartPlan {
  const logPath = logPathFor(tier.provider, n);
  if (tier.engine === "strata") {
    const argv = [tier.python!, "serve/server.py", "--engine", "strata", "--config", tier.config!, "--port", String(port)];
    const line = `cd ${shq(tier.strataDir!)} && nohup ${argv.map(shq).join(" ")} > ${shq(logPath)} 2>&1 < /dev/null &`;
    return { env: {}, argv, cwd: tier.strataDir, logPath, readyMs: STRATA_READY_MS, line };
  }
  if (tier.engine === "script") {
    const argv = ["/bin/bash", tier.start!, "--port", String(port)];
    const env = { PORT: String(port) };
    const line = `PORT=${port} nohup ${argv.map(shq).join(" ")} > ${shq(logPath)} 2>&1 < /dev/null &`;
    return { env, argv, logPath, readyMs: STRATA_READY_MS, line };
  }
  const l = cfg.launcher;
  const argv = [
    l.python, l.script, "serve", resolveModelPath(tier.model),
    "--served-model-name", tier.served,
    "--port", String(port),
    ...l.flags, ...tier.flags,
    "--default-chat-template-kwargs", l.templateKwargs,
  ];
  const envPart = Object.entries(l.env).map(([k, v]) => `${k}=${shq(v)}`).join(" ");
  const line = `${envPart ? envPart + " " : ""}nohup ${argv.map(shq).join(" ")} > ${shq(logPath)} 2>&1 < /dev/null &`;
  return { env: l.env, argv, logPath, readyMs: VLLM_READY_MS, line };
}

/** The vllm-mlx stop line (kept as is for the existing recipe). */
export function stopLine(cfg: LocalConfig): string {
  return `for p in $(pgrep -f ${shq(cfg.launcher.processMatch)}); do kill $p; done`;
}

/** Shell lines that stop every local server PAI knows: vllm-mlx, Strata, script ports. */
export function stopLines(cfg: LocalConfig): string[] {
  const lines = [stopLine(cfg)];
  const tiers = Object.values(cfg.tiers);
  if (tiers.some((t) => t.engine === "strata")) {
    lines.push(`for p in $(pgrep -f ${shq(STRATA_SERVER_MATCH)}); do kill $p; done`);
    for (const exe of new Set(tiers.map((t) => t.exe).filter((e): e is string => !!e))) {
      lines.push(`for p in $(pgrep -f ${shq(exe + " --serve")}); do kill $p; done`);
    }
  }
  for (const port of new Set(tiers.filter((t) => t.engine === "script").map((t) => t.port))) {
    lines.push(`for p in $(lsof -nP -iTCP:${port} -sTCP:LISTEN -t); do kill $p; done`);
  }
  return lines;
}

export interface RunningServer {
  pid: number;
  rssKb: number;
  port: number | null;
  tier: string | null;
  provider: string | null;
  /** 1 on the model's base port, 1+k on basePort+k (the order allocatePort hands out); null when unknown. */
  instance?: number | null;
}

const STRATA_SERVER_MATCH = "serve/server.py --engine strata";

const MAX_PORT_SPREAD = 50;

function instanceOf(t: LocalTier | undefined, port: number | null): number | null {
  if (!t || port === null) return null;
  const k = port - t.port;
  return k >= 0 && k <= MAX_PORT_SPREAD ? k + 1 : null;
}

/**
 * Parse `ps -axo pid=,rss=,command=` output for every local model server PAI
 * knows: vllm-mlx (processMatch), Strata server.py and its engine child (the
 * tier configs' exe), and — through `listeners` (port → pids, from lsof) —
 * whatever listens on a script tier's port.
 */
export function parseServers(
  psOut: string,
  cfg: LocalConfig,
  selfPid = process.pid,
  listeners: Record<number, number[]> = {},
  /** port → provider name from workers.yaml `providers:` urls, for servers that run no configured tier. */
  providerByPort: Record<number, string> = {},
): RunningServer[] {
  const out: RunningServer[] = [];
  const rssOf = new Map<number, number>();
  const tiers = Object.values(cfg.tiers);
  const exeTier = new Map<string, LocalTier>();
  for (const t of tiers) if (t.exe) exeTier.set(t.exe, t);
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[3];
    rssOf.set(pid, Number(m[2]));
    if (pid === selfPid) continue;
    const pm = /--port\s+(\d+)/.exec(cmd);
    const port = pm ? Number(pm[1]) : null;
    const add = (t: LocalTier | undefined, p: number | null): void => {
      out.push({ pid, rssKb: Number(m[2]), port: p, tier: t?.tier ?? null, provider: t?.provider ?? (p !== null ? providerByPort[p] : undefined) ?? null, instance: instanceOf(t, p) });
    };
    // vllm-mlx; skip the CLI / shells that merely mention the match string
    if (cmd.includes(cfg.launcher.processMatch) && /\bserve\b/.test(cmd) && cmd.includes("--port")) {
      // a tier is found by its model path first (a second copy runs on another port), then by base port
      const served = /\bserve\s+(\S+)/.exec(cmd)?.[1];
      add(
        tiers.find((t) => t.engine === "vllm-mlx" && served !== undefined && resolveModelPath(t.model) === served) ??
          tiers.find((t) => t.port === port && t.engine === "vllm-mlx") ?? tiers.find((t) => t.port === port),
        port,
      );
      continue;
    }
    // Strata server.py (python <venv>/python serve/server.py --engine strata ...)
    if (cmd.includes(STRATA_SERVER_MATCH) && pm) {
      const cfgPath = /--config\s+(\S+)/.exec(cmd)?.[1];
      add(tiers.find((t) => t.engine === "strata" && t.config === cfgPath) ?? tiers.find((t) => t.engine === "strata" && t.port === port), port);
      continue;
    }
    // the Strata engine child: "<exe> --serve ..."
    const exe = [...exeTier.keys()].find((e) => cmd.startsWith(e + " --serve"));
    if (exe) add(exeTier.get(exe), port);
  }
  const seen = new Set(out.map((s) => s.pid));
  for (const t of tiers) {
    if (t.engine !== "script") continue;
    for (const pid of listeners[t.port] ?? []) {
      if (pid === selfPid || seen.has(pid)) continue;
      seen.add(pid);
      out.push({ pid, rssKb: rssOf.get(pid) ?? 0, port: t.port, tier: t.tier, provider: t.provider, instance: 1 });
    }
  }
  return out;
}

/**
 * The tier that is active: the first whose port answers /v1/models with the
 * tier's model name (any answer when the tier names none). `fetchModels`
 * returns the served ids, or null when the port does not answer.
 */
export async function activeTier(
  cfg: LocalConfig,
  fetchModels: (port: number) => Promise<string[] | null>,
): Promise<LocalTier | null> {
  for (const t of Object.values(cfg.tiers)) {
    const ids = await fetchModels(t.port);
    if (ids && (!t.served || ids.includes(t.served))) return t;
  }
  return null;
}

/** GET /v1/models on a loopback port: the ids, or null when nothing answers. */
export async function fetchServedModels(port: number): Promise<string[] | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { id?: unknown }[] };
    return (j.data ?? []).map((d) => String(d.id ?? ""));
  } catch {
    return null;
  }
}

/** The tiers as the cockpit buttons need them. */
export function tierButtons(cfg: LocalConfig): { tier: string; label: string; memoryGb?: number }[] {
  return Object.values(cfg.tiers).map((t) => ({ tier: t.tier, label: t.label, ...(t.memoryGb !== undefined ? { memoryGb: t.memoryGb } : {}) }));
}

export function fmtRss(kb: number): string {
  return kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Model directories on disk: HF snapshots and LM Studio models, nothing else. */
export function installedModelDirs(home = homedir()): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const ls = (d: string): string[] => {
    try {
      return readdirSync(d).sort();
    } catch {
      return [];
    }
  };
  const hub = join(home, ".cache/huggingface/hub");
  for (const e of ls(hub)) {
    if (!e.startsWith("models--")) continue;
    const snap = ls(join(hub, e, "snapshots"))[0];
    if (snap) out.push({ name: e.split("--").slice(2).join("--"), path: join(hub, e, "snapshots", snap) });
  }
  const lms = join(home, ".lmstudio/models");
  for (const org of ls(lms)) {
    for (const m of ls(join(lms, org))) out.push({ name: m, path: join(lms, org, m) });
  }
  return out;
}

/**
 * Model path for a provider's default model name (e.g. "qwen3-coder-30b"):
 * the first installed directory whose name contains it, ignoring case and
 * punctuation. Null when nothing matches.
 */
export function findModelPath(served: string, dirs: { name: string; path: string }[] = installedModelDirs()): string | null {
  const want = norm(served);
  if (!want) return null;
  return dirs.find((d) => norm(d.name).includes(want))?.path ?? null;
}

/**
 * The active tier among candidates: the first one that is a tier and whose server
 * answers. The one definition behind both the runtimes inventory and the cockpit
 * LIMITS panel, so a tier switch shows the same active model in both.
 */
export function firstRunningTier<T>(items: T[], isTier: (t: T) => boolean, running: (t: T) => boolean): T | undefined {
  return items.find((t) => isTier(t) && running(t));
}
