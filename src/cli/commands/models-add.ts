/**
 * `pai models add <hf-id|path>`: put a new local model into the registry (workers.yaml) with its whole
 * lifecycle written out — location, start command, health URL, port — as a DISABLED provider plus a
 * local_tiers entry. It never enables or routes to the model. `--try` runs one smoke test.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { allocatePort, canBind } from "../../workers/local-memory.js";
import { sizeOnDiskGb } from "../../workers/local-memory.js";
import { defaultLauncher, parseLocalConfig, planStart, shellQuote, type LocalConfig } from "../../workers/local-tiers.js";
import { hashText, saveRegistry, defaultRegistryCtx } from "../../router/cockpit-registry.js";
import { workersYamlPath } from "../../workers/workers-config.js";
import { healthOk, killInstance, launchDetached, portListeners } from "./worker-config.js";

export type ModelFormat = "mlx" | "gguf";

export interface AddOptions {
  source: string;
  name?: string;
  /** Fetch an HF id that is not on disk. Without it the weights must exist locally. */
  download?: boolean;
  /** Smoke test after writing the entry. */
  try?: boolean;
}

export interface AddDeps {
  yamlPath?: string;
  home?: string;
  /** Absolute path of an executable on PATH, or null. */
  which?: (cmd: string) => string | null;
  /** Download an HF id into the hub cache (only called with --download). */
  download?: (id: string) => void;
  bindable?: (port: number) => Promise<boolean>;
  /** Smoke test steps (defaults: the real server). */
  smoke?: SmokeDeps;
}

export interface AddResult {
  ok: boolean;
  message: string;
  name?: string;
  port?: number;
  runtime?: string;
  location?: string;
  format?: ModelFormat;
  smoke?: SmokeResult;
}

export interface SmokeResult {
  ok: boolean;
  message: string;
  tokPerSec?: number;
  rssMb?: number;
}

export interface SmokeDeps {
  launch?: typeof launchDetached;
  health?: (url: string) => Promise<boolean>;
  /** One completion of `maxTokens`; returns the generated token count. */
  complete?: (baseUrl: string, served: string, maxTokens: number) => Promise<number>;
  rssMb?: (port: number) => number | undefined;
  kill?: (port: number, pid: number | undefined, stopCommand: string | undefined) => Promise<void>;
  readyMs?: number;
  pollMs?: number;
}

const HF_ID = /^[\w.-]+\/[\w.-]+$/;
const FIRST_PORT = 8040;

const whichOnPath = (cmd: string): string | null => {
  try {
    return execFileSync("/usr/bin/which", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
};

const ls = (d: string): string[] => {
  try {
    return readdirSync(d).sort();
  } catch {
    return [];
  }
};

/** Snapshot directory of an HF id in the hub cache, or null. */
function hubSnapshot(id: string, home: string): string | null {
  const dir = join(home, ".cache/huggingface/hub", `models--${id.replace("/", "--")}`, "snapshots");
  const snap = ls(dir)[0];
  return snap ? join(dir, snap) : null;
}

/** The weights on disk for a path or HF id; null when absent. */
export function resolveWeights(source: string, home: string): string | null {
  if (existsSync(source)) return source;
  if (HF_ID.test(source)) return hubSnapshot(source, home);
  return null;
}

/** What the weights are and which file the server loads; a reason when neither MLX nor GGUF. */
export function detectFormat(path: string): { format: ModelFormat; file?: string } | { reason: string } {
  const st = statSync(path);
  if (st.isFile()) {
    return path.endsWith(".gguf") ? { format: "gguf", file: path } : { reason: `${path} is a file but not a .gguf` };
  }
  const names = ls(path);
  const gguf = names.filter((n) => n.endsWith(".gguf") && !/mmproj/i.test(n));
  if (gguf.length) return { format: "gguf", file: join(path, gguf[0]!) };
  if (names.includes("config.json") && names.some((n) => n.endsWith(".safetensors"))) return { format: "mlx" };
  return { reason: `no MLX (config.json + *.safetensors) or GGUF (*.gguf) weights in ${path} (found: ${names.slice(0, 8).join(", ") || "nothing"})` };
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");

/** Name from the source: the HF repo name or the directory / file name. */
function defaultName(source: string): string {
  const base = HF_ID.test(source) && !existsSync(source) ? source.split("/")[1]! : basename(source).replace(/\.gguf$/, "");
  return slug(base) || "model";
}

export async function addModel(opts: AddOptions, deps: AddDeps = {}): Promise<AddResult> {
  const home = deps.home ?? homedir();
  const which = deps.which ?? whichOnPath;
  const yamlPath = deps.yamlPath ?? workersYamlPath();

  let location = resolveWeights(opts.source, home);
  if (!location) {
    if (!opts.download) {
      return { ok: false, message: `${opts.source}: not found locally; pass --download to fetch an HF id` };
    }
    if (!HF_ID.test(opts.source)) return { ok: false, message: `${opts.source}: not a path that exists nor an HF id (org/name), nothing to download` };
    try {
      (deps.download ?? ((id) => void execFileSync("huggingface-cli", ["download", id], { stdio: "inherit" })))(opts.source);
    } catch (e) {
      return { ok: false, message: `download of ${opts.source} failed: ${(e as Error).message}` };
    }
    location = resolveWeights(opts.source, home);
    if (!location) return { ok: false, message: `${opts.source}: download finished but no snapshot appeared in the hub cache` };
  }

  const fmt = detectFormat(location);
  if ("reason" in fmt) return { ok: false, message: `refused: ${fmt.reason}` };

  const launcher = defaultLauncher();
  let runtime: string;
  let startCommand: string;
  if (fmt.format === "mlx") {
    runtime = "mlx_lm.server";
    startCommand = [launcher.python, "-m", "mlx_lm.server", "--model", location, "--host", "127.0.0.1", "--port", "{port}"].map(shellQuote).join(" ");
  } else {
    const bin = which("llama-server");
    if (!bin) return { ok: false, message: `refused: ${location} is GGUF and llama-server (llama.cpp) is not installed; install it (brew install llama.cpp) and retry` };
    runtime = "llama-server";
    startCommand = [bin, "-m", fmt.file!, "--host", "127.0.0.1", "--port", "{port}"].map(shellQuote).join(" ");
  }

  const name = slug(opts.name ?? defaultName(opts.source));
  const text = existsSync(yamlPath) ? readFileSync(yamlPath, "utf8") : "";
  const doc = parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length) return { ok: false, message: `${yamlPath} does not parse: ${doc.errors[0]!.message.split("\n")[0]}` };
  const root = (doc.toJS() ?? {}) as { providers?: Record<string, { url?: unknown }>; local_tiers?: Record<string, { port?: unknown }> };
  if (root.local_tiers?.[name] || root.providers?.[name]) return { ok: false, message: `"${name}" already exists in the registry; pick another --name` };

  const taken: number[] = [];
  for (const t of Object.values(root.local_tiers ?? {})) if (typeof t?.port === "number") taken.push(t.port);
  for (const p of Object.values(root.providers ?? {})) {
    const m = typeof p?.url === "string" ? /:(\d+)(?:\/|$)/.exec(p.url) : null;
    if (m) taken.push(Number(m[1]));
  }
  let port: number;
  try {
    port = await allocatePort(Math.max(FIRST_PORT, ...taken.map((p) => p + 1)), taken, deps.bindable ?? canBind);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  const gb = sizeOnDiskGb(location);
  const entry: Record<string, unknown> = {
    engine: "command",
    provider: name,
    label: name,
    location,
    start_command: startCommand,
    health: "http://127.0.0.1:{port}/v1/models",
    served: name,
    port,
    ...(gb > 0 ? { memoryGb: Math.ceil(gb * 1.2) } : {}),
  };
  if (!doc.contents || !isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  doc.setIn(["providers", name], doc.createNode({ url: `http://127.0.0.1:${port}/v1`, enabled: false, models: { default: name } }));
  doc.setIn(["local_tiers", name], doc.createNode(entry));
  const saved = saveRegistry(String(doc), hashText(text), defaultRegistryCtx(yamlPath));
  if (!saved.ok) return { ok: false, message: `registry rejected the entry: ${saved.error}` };

  const res: AddResult = {
    ok: true,
    name,
    port,
    runtime,
    location,
    format: fmt.format,
    message: `added ${name} (${fmt.format}, ${runtime}) on port ${port}, DISABLED: provider ${name} has enabled: false and nothing routes to it. Start it with \`pai worker local start ${name}\`.`,
  };
  if (opts.try) {
    const cfg = parseLocalConfig(
      parseDocument(readFileSync(yamlPath, "utf8")).toJS() as Record<string, unknown>,
      { [name]: { url: `http://127.0.0.1:${port}/v1`, model: name } },
    );
    res.smoke = await smokeTest(cfg, name, deps.smoke);
    res.message += `\nsmoke test: ${res.smoke.message}`;
    if (!res.smoke.ok) res.ok = false;
  }
  return res;
}

async function defaultComplete(baseUrl: string, served: string, maxTokens: number): Promise<number> {
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: served, max_tokens: maxTokens, messages: [{ role: "user", content: "Count from one to twenty." }] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`completion answered HTTP ${r.status}`);
  const j = (await r.json()) as { usage?: { completion_tokens?: number } };
  return j.usage?.completion_tokens ?? maxTokens;
}

function defaultRssMb(port: number): number | undefined {
  const pid = portListeners(port)[0];
  if (pid === undefined) return undefined;
  try {
    const kb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return kb > 0 ? Math.round(kb / 1024) : undefined;
  } catch {
    return undefined;
  }
}

/** Start the entry, wait for its health URL, run one 16-token completion, stop it; report tok/s and memory. */
export async function smokeTest(cfg: LocalConfig, name: string, d: SmokeDeps = {}): Promise<SmokeResult> {
  const tier = cfg.tiers[name]!;
  const plan = planStart(cfg, tier);
  const launch = d.launch ?? launchDetached;
  const health = d.health ?? ((url: string) => healthOk({ health: url }, tier.port));
  const exited = launch(plan);
  const stop = async (): Promise<void> => {
    const pid = portListeners(tier.port)[0];
    await (d.kill ?? ((port, p, cmd) => killInstance({ id: `${name}#1`, model: name, provider: tier.provider, url: "", origin: "managed", port, ...(p !== undefined ? { pid: p } : {}), state: "ready", startedAt: 0, log: "" }, undefined, undefined, cmd)))(tier.port, pid, tier.stopCommand);
  };
  const url = tier.health.replaceAll("{port}", String(tier.port));
  const deadline = Date.now() + (d.readyMs ?? plan.readyMs);
  try {
    while (!(await health(url))) {
      const code = exited();
      if (code !== null && code !== 0) return { ok: false, message: `server exited (${code}); see ${plan.logPath}` };
      if (Date.now() > deadline) return { ok: false, message: `not healthy in time; see ${plan.logPath}` };
      await new Promise((r) => setTimeout(r, d.pollMs ?? 2000));
    }
    const t0 = Date.now();
    const tokens = await (d.complete ?? defaultComplete)(`http://127.0.0.1:${tier.port}/v1`, tier.served || name, 16);
    const secs = Math.max(0.001, (Date.now() - t0) / 1000);
    const rssMb = (d.rssMb ?? defaultRssMb)(tier.port);
    const tokPerSec = Math.round((tokens / secs) * 10) / 10;
    return { ok: true, tokPerSec, ...(rssMb !== undefined ? { rssMb } : {}), message: `${tokens} tokens at ${tokPerSec} tok/s, memory ${rssMb !== undefined ? `${rssMb} MB` : "unknown"}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  } finally {
    await stop().catch(() => undefined);
  }
}
