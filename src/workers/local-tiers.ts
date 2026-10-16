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
import { join } from "node:path";
import { parse } from "yaml";
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
}

export interface LocalTier {
  tier: string;
  provider: string;
  /** Model path; a `*` path segment is expanded against the directory. */
  model: string;
  served: string;
  port: number;
  flags: string[];
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

export function defaultLauncher(): LocalLauncher {
  const home = homedir();
  return {
    python: join(home, ".local/share/uv/tools/vllm-mlx/bin/python"),
    script: join(home, ".local/share/vllm-mlx-serve/serve_patched_fold_text.py"),
    flags: DEFAULT_COMMON_FLAGS.split(/\s+/),
    templateKwargs: '{"enable_thinking": false}',
    env: { PF_FORCE_TEXT: "1" },
    processMatch: "serve_patched",
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
      const model = str(t.model, `${where}.model`);
      if (!model) throw new LocalTierError(`${where}.model: required`);
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
      if (!served) throw new LocalTierError(`${where}.served: missing and provider "${provider}" has no default model`);
      tiers[name] = { tier: name, provider, model: expandHome(model), served, port, flags: flagList(t.flags, `${where}.flags`) };
    }
  }
  return { launcher, tiers };
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
  logPath: string;
  /** Shell rendering of the above, log redirect included. */
  line: string;
}

export function logPathFor(provider: string): string {
  return join(homedir(), ".cache/pai/local-server", `${provider}.log`);
}

export function planStart(cfg: LocalConfig, tier: LocalTier): StartPlan {
  const l = cfg.launcher;
  const argv = [
    l.python, l.script, "serve", resolveModelPath(tier.model),
    "--served-model-name", tier.served,
    "--port", String(tier.port),
    ...l.flags, ...tier.flags,
    "--default-chat-template-kwargs", l.templateKwargs,
  ];
  const logPath = logPathFor(tier.provider);
  const envPart = Object.entries(l.env).map(([k, v]) => `${k}=${shq(v)}`).join(" ");
  const line = `${envPart ? envPart + " " : ""}nohup ${argv.map(shq).join(" ")} > ${shq(logPath)} 2>&1 < /dev/null &`;
  return { env: l.env, argv, logPath, line };
}

export function stopLine(cfg: LocalConfig): string {
  return `for p in $(pgrep -f ${shq(cfg.launcher.processMatch)}); do kill $p; done`;
}

export interface RunningServer {
  pid: number;
  rssKb: number;
  port: number | null;
  tier: string | null;
  provider: string | null;
}

/** Parse `ps -axo pid=,rss=,command=` output for servers matching processMatch. */
export function parseServers(psOut: string, cfg: LocalConfig, selfPid = process.pid): RunningServer[] {
  const out: RunningServer[] = [];
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[3];
    if (pid === selfPid || !cmd.includes(cfg.launcher.processMatch)) continue;
    // Skip the CLI / shells that merely mention the match string.
    if (!/\bserve\b/.test(cmd) || !cmd.includes("--port")) continue;
    const pm = /--port\s+(\d+)/.exec(cmd);
    const port = pm ? Number(pm[1]) : null;
    const tier = Object.values(cfg.tiers).find((t) => t.port === port) ?? null;
    out.push({ pid, rssKb: Number(m[2]), port, tier: tier?.tier ?? null, provider: tier?.provider ?? null });
  }
  return out;
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
