/**
 * model-inventory.ts — one inventory of every local model runtime PAI knows,
 * the models each holds and who uses them. Detectors only query status
 * endpoints (ollama /api/ps + /api/tags, `docker model ls|status|ps`,
 * /v1/models of the loopback worker providers); they never load a model.
 * The daemon refreshes the answer every 30 s into <logDir>/model-inventory.json
 * (same pattern as local-status); `pai models`, the `models_list` MCP tool and
 * the cockpit LOCAL section read it.
 *
 * config.yaml:
 *   models:
 *     runtimes:  [{name, kind, url}]          # extra/overriding endpoints
 *     consumers: [{name, runtime, model?}]    # users PAI cannot see itself
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, readMainConfigRaw } from "../daemon/config.js";
import { readWorkersSection, type WorkersConfig } from "./config.js";
import { workersLogDir } from "./paths.js";
import { isLoopbackProvider } from "./run-env.js";
import { providerHostPort } from "./local-provider.js";

export const MODEL_INVENTORY_REFRESH_MS = 30_000;
export const MODEL_INVENTORY_MAX_AGE_MS = 90_000;
const PROBE_MS = 2000;

export type ModelKind = "chat" | "coding" | "embedding";
export type RuntimeKind = "ollama" | "docker-model-runner" | "strata" | "vllm-mlx" | "llama-server" | "openai-server" | "in-process";

export interface InventoryModel {
  model: string;
  kind: ModelKind;
  loaded: boolean;
  memoryMb?: number;
  /** size on disk (ollama /api/tags `size`, `docker model ls` SIZE column) */
  sizeMb?: number;
  usedBy: string[];
}

export interface InventoryRuntime {
  name: string;
  kind: RuntimeKind;
  status: "running" | "stopped";
  port?: number;
  models: InventoryModel[];
  /** every consumer pointing at this runtime */
  users: string[];
}

export interface ModelInventory {
  at: string;
  runtimes: InventoryRuntime[];
  duplicates: string[];
}

export interface DeclaredRuntime {
  name: string;
  kind: RuntimeKind;
  url?: string;
}
export interface DeclaredConsumer {
  name: string;
  runtime: string;
  model?: string;
}

/** Everything a detector needs from the outside; tests inject fakes. */
export interface InventoryDeps {
  getJson: (url: string) => Promise<unknown | null>;
  run: (cmd: string, args: string[]) => Promise<string | null>;
  /** summed RSS in MB of the process tree listening on a port (the engine child, not only the listener) */
  rssMb: (port: number) => Promise<number | undefined>;
}

export interface InventoryInput {
  providers: WorkersConfig["providers"];
  embedding: { backend: string; model?: string; ollamaUrl: string; inProcessModel: string };
  runtimes: DeclaredRuntime[];
  consumers: DeclaredConsumer[];
}

const exec = (cmd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 4000, maxBuffer: 1 << 20 }, (e, stdout) => resolve(e ? null : String(stdout)));
    } catch {
      resolve(null);
    }
  });

export const liveDeps: InventoryDeps = {
  async getJson(url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
  run: exec,
  async rssMb(port) {
    const pid = ((await exec("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])) ?? "").split("\n")[0];
    if (!pid) return undefined;
    const tree = await processTreeRssMb(pid, exec);
    return tree > 0 ? tree : undefined;
  },
};

/**
 * Summed RSS (MB) of a process and all its descendants. A loopback server's
 * listener is often a thin python/node front (Strata: ~30 MB) while the engine
 * child holds the model (~50 GB); the listener's own RSS says nothing.
 * `ps -o pid=,ppid=,rss=` once, then walk the tree.
 */
export async function processTreeRssMb(rootPid: string, run: (cmd: string, args: string[]) => Promise<string | null> = exec): Promise<number> {
  const out = await run("ps", ["-axo", "pid=,ppid=,rss="]);
  if (!out) return 0;
  const kids = new Map<string, Array<{ pid: string; rss: number }>>();
  const own = new Map<string, number>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    const [, pid, ppid, rss] = m;
    own.set(pid!, Number(rss));
    const list = kids.get(ppid!) ?? [];
    list.push({ pid: pid!, rss: Number(rss) });
    kids.set(ppid!, list);
  }
  let sum = own.get(rootPid) ?? 0; // the listener's own RSS counts too
  const seen = new Set<string>([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const k of kids.get(stack.pop()!) ?? []) {
      if (seen.has(k.pid)) continue; // a reparented cycle must not loop forever
      seen.add(k.pid);
      sum += k.rss;
      stack.push(k.pid);
    }
  }
  return Math.round(sum / 1024);
}

export function modelKind(name: string): ModelKind {
  return /embed|e5-|bge-|minilm|arctic|gte-|nomic/i.test(name) ? "embedding" : "chat";
}

const mb = (bytes: number): number => Math.round(bytes / 1048576);

/** "598.63MiB" / "4.68 GiB" → MB */
export function parseSizeMb(s: string): number | undefined {
  const m = s.trim().match(/^([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)$/i);
  if (!m) return undefined;
  const mult: Record<string, number> = { k: 1 / 1024, m: 1, g: 1024, t: 1048576 };
  return Math.round(Number(m[1]) * mult[m[2][0].toLowerCase()]);
}

/** Rows of a column-aligned `docker model ls|ps` table, cells cut at the header's column starts. */
export function parseTable(text: string): Array<Record<string, string>> {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0];
  const cols: Array<{ name: string; at: number }> = [];
  for (const m of header.matchAll(/\S+(?: \S+)*/g)) cols.push({ name: m[0], at: m.index ?? 0 });
  return lines.slice(1).map((l) => {
    const row: Record<string, string> = {};
    cols.forEach((c, i) => (row[c.name] = l.slice(c.at, cols[i + 1]?.at).trim()));
    return row;
  });
}

function matches(consumerModel: string, model: string): boolean {
  const a = consumerModel.toLowerCase();
  const b = model.toLowerCase();
  return a === b || b.includes(a) || a.includes(b);
}

/** Attach consumers: runtime-level users always, model-level usedBy by (exact, else loose) model match. */
function attach(rt: InventoryRuntime, users: Array<{ name: string; model?: string }>): void {
  for (const u of users) {
    if (!rt.users.includes(u.name)) rt.users.push(u.name);
    if (!u.model) continue;
    const exact = rt.models.filter((m) => m.model.toLowerCase() === u.model!.toLowerCase());
    for (const m of exact.length ? exact : rt.models.filter((x) => matches(u.model!, x.model))) {
      if (!m.usedBy.includes(u.name)) m.usedBy.push(u.name);
    }
  }
}

async function detectOllama(input: InventoryInput, deps: InventoryDeps): Promise<InventoryRuntime> {
  const decl = input.runtimes.find((r) => r.kind === "ollama");
  const base = (decl?.url ?? input.embedding.ollamaUrl).replace(/\/+$/, "");
  const port = Number(new URL(base).port) || 11434;
  const [ps, tags] = await Promise.all([deps.getJson(`${base}/api/ps`), deps.getJson(`${base}/api/tags`)]);
  const rt: InventoryRuntime = { name: decl?.name ?? "ollama", kind: "ollama", status: ps || tags ? "running" : "stopped", port, models: [], users: [] };
  type OM = { name?: string; size?: number; size_vram?: number };
  const loaded = ((ps as { models?: OM[] } | null)?.models ?? []).filter((m) => m.name);
  const installed = ((tags as { models?: OM[] } | null)?.models ?? []).filter((m) => m.name);
  for (const m of loaded) rt.models.push({ model: m.name!, kind: modelKind(m.name!), loaded: true, memoryMb: m.size ? mb(m.size) : undefined, sizeMb: m.size ? mb(m.size) : undefined, usedBy: [] });
  for (const m of installed) {
    if (!rt.models.some((x) => x.model === m.name)) rt.models.push({ model: m.name!, kind: modelKind(m.name!), loaded: false, sizeMb: m.size ? mb(m.size) : undefined, usedBy: [] });
  }
  return rt;
}

async function detectDocker(deps: InventoryDeps): Promise<InventoryRuntime | null> {
  const status = await deps.run("docker", ["model", "status"]);
  const ls = await deps.run("docker", ["model", "ls"]);
  if (status === null && ls === null) return null; // docker or the plugin is absent
  const running = /is running/i.test(status ?? "");
  const rt: InventoryRuntime = { name: "docker-model-runner", kind: "docker-model-runner", status: running ? "running" : "stopped", models: [], users: [] };
  const psRows = running ? parseTable((await deps.run("docker", ["model", "ps"])) ?? "") : [];
  const loadedNames = new Set(psRows.map((r) => r["MODEL NAME"]).filter(Boolean));
  for (const r of parseTable(ls ?? "")) {
    const name = r["MODEL NAME"];
    if (!name) continue;
    rt.models.push({ model: name, kind: modelKind(name), loaded: loadedNames.has(name), sizeMb: parseSizeMb(r["SIZE"] ?? ""), usedBy: [] });
  }
  return rt;
}

async function detectProviders(input: InventoryInput, deps: InventoryDeps): Promise<InventoryRuntime[]> {
  const byPort = new Map<string, { host: string; port: number; names: string[]; enabled: string[]; defaults: string[] }>();
  for (const [name, p] of Object.entries(input.providers)) {
    // a DISABLED provider is no user of anything: it must not surface as a
    // stopped runtime "used by worker:<name>" (~17 such rows seen live)
    if (!p.enabled || !isLoopbackProvider(p)) continue;
    const hp = providerHostPort(p);
    if (!hp) continue;
    const key = String(hp.port);
    const e = byPort.set(key, byPort.get(key) ?? { host: hp.host, port: hp.port, names: [], enabled: [], defaults: [] }).get(key)!;
    e.names.push(name);
    e.enabled.push(name);
    if (p.models.default && !e.defaults.includes(p.models.default)) e.defaults.push(p.models.default);
  }
  const ollamaPort = Number(new URL(input.embedding.ollamaUrl).port) || 11434;
  const out: InventoryRuntime[] = [];
  await Promise.all(
    [...byPort.values()]
      .filter((e) => e.port !== ollamaPort)
      .map(async (e) => {
        const h = e.host.includes(":") ? `[${e.host}]` : e.host;
        const body = (await deps.getJson(`http://${h}:${e.port}/v1/models`)) as { data?: Array<{ id?: string }> } | null;
        const ids = (body?.data ?? []).map((d) => d.id).filter((x): x is string => !!x);
        const running = body !== null;
        const rss = running ? await deps.rssMb(e.port) : undefined;
        // a declared endpoint (e.g. strata) can sit behind a provider that is
        // DISABLED in workers.yaml: keep the runtime, attach no worker user
        const decl = input.runtimes.find((r) => r.url && Number(new URL(r.url).port) === e.port);
        const rt: InventoryRuntime = {
          name: decl?.name ?? e.enabled[0] ?? e.names[0],
          kind: decl?.kind ?? "openai-server",
          status: running ? "running" : "stopped",
          port: e.port,
          models: (running && ids.length ? ids : e.defaults).map((m) => ({ model: m, kind: "coding" as const, loaded: running, usedBy: [] })),
          users: [],
        };
        if (rss && rt.models.length) rt.models[0].memoryMb = rss;
        attach(rt, e.enabled.map((n) => ({ name: `worker:${n}` })));
        out.push(rt);
      })
  );
  return out;
}

function duplicates(runtimes: InventoryRuntime[]): string[] {
  const jobs: Array<[string, (k: ModelKind) => boolean]> = [
    ["embedding", (k) => k === "embedding"],
    ["chat/coding", (k) => k !== "embedding"],
  ];
  const hints: string[] = [];
  for (const [job, pick] of jobs) {
    const rts = runtimes.filter((r) => r.status === "running" && r.models.some((m) => pick(m.kind) && (m.loaded || m.usedBy.length)));
    if (rts.length < 2) continue;
    const parts = rts.map((r) => {
      const ms = r.models.filter((m) => pick(m.kind) && (m.loaded || m.usedBy.length)).map((m) => m.model);
      return `${r.name} (${ms.join(", ")})`;
    });
    hints.push(`${job} runs on ${rts.length} runtimes: ${parts.join(" + ")} — consider consolidating`);
  }
  return hints;
}

/** Pure part: detectors + consumers → inventory. */
export async function computeInventory(input: InventoryInput, deps: InventoryDeps = liveDeps, now = new Date()): Promise<ModelInventory> {
  const [ollama, docker, provs] = await Promise.all([detectOllama(input, deps), detectDocker(deps), detectProviders(input, deps)]);
  const runtimes: InventoryRuntime[] = [...provs, ollama, ...(docker ? [docker] : [])];
  for (const d of input.runtimes) {
    if (!d.url || ["ollama", "docker-model-runner"].includes(d.kind)) continue;
    // declared endpoints with no loopback provider behind them
    const port = Number(new URL(d.url).port);
    if (runtimes.some((r) => r.port === port)) continue;
    const body = (await deps.getJson(`${d.url.replace(/\/+$/, "")}/v1/models`)) as { data?: Array<{ id?: string }> } | null;
    runtimes.push({
      name: d.name,
      kind: d.kind,
      status: body ? "running" : "stopped",
      port,
      models: (body?.data ?? []).map((x) => ({ model: x.id ?? "?", kind: modelKind(x.id ?? ""), loaded: true, usedBy: [] })),
      users: [],
    });
  }
  const emb = input.embedding;
  if (emb.backend === "ollama-f16") {
    attach(ollama, [{ name: "pai-embedding", model: emb.model ?? "arctic-embed-m-v1.5-f16" }]);
  } else {
    runtimes.push({
      name: "pai",
      kind: "in-process",
      status: "running",
      models: [{ model: emb.inProcessModel, kind: "embedding", loaded: true, usedBy: ["pai-embedding"] }],
      users: ["pai-embedding"],
    });
  }
  for (const c of input.consumers) {
    const rt = runtimes.find((r) => r.name === c.runtime || r.kind === c.runtime);
    if (rt) attach(rt, [{ name: c.name, model: c.model }]);
  }
  return { at: now.toISOString(), runtimes, duplicates: duplicates(runtimes) };
}

/** Read models.runtimes / models.consumers and the embedding backend from config.yaml, providers from workers.yaml. */
export function readInventoryInput(): InventoryInput {
  const cfg = loadConfig();
  let raw: Record<string, unknown> = {};
  try {
    raw = readMainConfigRaw();
  } catch {
    // unreadable config: no declared runtimes or consumers
  }
  const m = (raw.models ?? {}) as { runtimes?: unknown; consumers?: unknown };
  const list = <T,>(v: unknown, ok: (x: Record<string, unknown>) => boolean): T[] =>
    Array.isArray(v) ? (v.filter((x) => x && typeof x === "object" && ok(x as Record<string, unknown>)) as T[]) : [];
  return {
    providers: readWorkersSection().workers.providers,
    embedding: { backend: cfg.embedding.backend, model: cfg.embedding.model, ollamaUrl: cfg.embedding.ollama.baseUrl, inProcessModel: cfg.embeddingModel },
    runtimes: list<DeclaredRuntime>(m.runtimes, (x) => typeof x.name === "string" && typeof x.kind === "string"),
    consumers: list<DeclaredConsumer>(m.consumers, (x) => typeof x.name === "string" && typeof x.runtime === "string"),
  };
}

export const inventoryPath = (logDir: string): string => join(logDir, "model-inventory.json");

export function writeInventory(logDir: string, inv: ModelInventory): void {
  const path = inventoryPath(logDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(inv) + "\n", "utf8");
  renameSync(tmp, path);
}

export function readInventory(logDir: string, now = Date.now(), maxAgeMs = MODEL_INVENTORY_MAX_AGE_MS): ModelInventory | null {
  const path = inventoryPath(logDir);
  if (!existsSync(path)) return null;
  try {
    const inv = JSON.parse(readFileSync(path, "utf8")) as ModelInventory;
    const at = Date.parse(inv.at);
    return Number.isNaN(at) || now - at > maxAgeMs || !Array.isArray(inv.runtimes) ? null : inv;
  } catch {
    return null;
  }
}

/** The daemon's cached inventory, else a fresh read-only probe. */
export async function currentInventory(): Promise<ModelInventory> {
  const logDir = workersLogDir(readWorkersSection().workers);
  return readInventory(logDir) ?? computeInventory(readInventoryInput());
}

/** Daemon side: refresh now and every 30 s. Returns the stop function. */
export function startInventoryRefresh(): () => void {
  const refresh = async (): Promise<void> => {
    try {
      writeInventory(workersLogDir(readWorkersSection().workers), await computeInventory(readInventoryInput()));
    } catch (e) {
      process.stderr.write(`[pai-daemon] Model inventory refresh error: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), MODEL_INVENTORY_REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export const fmtMem = (m?: number): string => (m == null ? "-" : m >= 1024 ? `${(m / 1024).toFixed(1)} GB` : `${m} MB`);

/** One row per model (a runtime with no models gets one row); stopped runtimes are listed after the running ones. */
export function inventoryRows(inv: ModelInventory): string[][] {
  const rows: string[][] = [];
  const ordered = [...inv.runtimes].sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
  for (const r of ordered) {
    const port = r.port != null ? String(r.port) : "-";
    if (r.status !== "running") {
      // stopped runtimes collapse to one row
      rows.push([r.name, r.status, r.models.map((m) => m.model).join(", ") || "-", [...new Set(r.models.map((m) => m.kind))].join(", ") || "-", "-", r.users.join(", ") || "-", port]);
      continue;
    }
    if (!r.models.length) rows.push([r.name, r.status, "-", "-", "-", r.users.join(", ") || "-", port]);
    for (const m of r.models) {
      rows.push([
        r.name,
        r.status,
        m.loaded || r.status !== "running" ? m.model : `${m.model} (installed)`,
        m.kind,
        // loaded: RSS; installed only: size on disk
        m.loaded ? fmtMem(m.memoryMb) : fmtMem(m.sizeMb),
        (m.usedBy.length ? m.usedBy : r.models.length === 1 ? r.users : []).join(", ") || "-",
        port,
      ]);
    }
  }
  return rows;
}

export const INVENTORY_HEADERS = ["runtime", "status", "model", "kind", "memory / on disk", "used by", "port"];

export function inventoryText(inv: ModelInventory, table: (headers: string[], rows: string[][]) => string): string {
  const lines = [table(INVENTORY_HEADERS, inventoryRows(inv))];
  for (const d of inv.duplicates) lines.push("", `duplicates: ${d}`);
  return lines.join("\n");
}
