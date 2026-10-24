/**
 * router.ts — local model router. One Claude Code session points its
 * ANTHROPIC_BASE_URL here and /model picks the provider: each POST
 * /v1/messages (and count_tokens) is routed by the body's `model`.
 *
 *   claude ids  → router.claudeUpstream, inbound auth passed through
 *   other ids   → the workers.yaml provider that lists the model; inbound auth
 *                 dropped, the provider key injected as Authorization: Bearer
 *
 * Bodies and keys are never logged.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { DEGENERATE_RETRY_TEXT, isDamaged, isDegenerate, readAnswer, retryBody } from "./malformed-retry.js";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import {
  BustDetector,
  emptyUsage,
  fingerprint,
  GapTracker,
  headerValue,
  sessionTag,
  UsageSniffer,
  verdict,
  type Usage,
  type UsageRow,
} from "./usage.js";
import { workersLogDir } from "../workers/paths.js";
import { recordToolError } from "../workers/tool-errors.js";
import { declaredToolNames, ToolCaseSse } from "./tool-case.js";
import { InputTokensSse, promptTokenCount } from "./prompt-tokens.js";
import { sharedParker } from "./parking.js";
import { createUpstreamStreak } from "./preflight.js";
import { newPrefill, schedEnabled, sharedScheduler } from "./scheduler.js";
import { loadConfig } from "../daemon/config.js";
import { readWorkersSection, resolveProviderKey, type WorkerProvider, ANTHROPIC_NATIVE } from "../workers/config.js";
import { tierProviderNames, withTierProviders } from "../workers/local-provider.js";
import { isLoopbackUrl, isLoopbackHostname } from "../utils/loopback.js";
import type { EndpointHealth } from "../workers/endpoint-health.js";
import { endpointRegistry, instanceEngineKey, instanceNumber, pickInstance, readInstances, type LocalInstance } from "../workers/local-instances.js";
import type { LocalConfig } from "../workers/local-tiers.js";
import { resolveSelector } from "../workers/route-table.js";
import { refuseUnlessLoopback, isTailnetOrLocalName } from "../utils/loopback-guard.js";
import { hostAllowed, originAllowed, isCockpitPath } from "./cockpit-auth.js";

/** The router's port (router.port in config.yaml). */
export const routerPort = (): number => loadConfig().router.port;
let streak: ReturnType<typeof createUpstreamStreak> | undefined;
/** Consecutive cloud-upstream network failures of this router process, written for the daemon's watchdog. */
const upstreamStreak = () => (streak ??= createUpstreamStreak());

/** Upstream for claude ids (router.claudeUpstream in config.yaml). */
export const claudeUpstream = (): string => loadConfig().router.claudeUpstream;

/** Queued-stream ping interval (router.scheduling.pingMs); PAI_ROUTER_PING_MS shortens it for tests. */
const pingMs = (): number => Number(process.env.PAI_ROUTER_PING_MS) || sharedScheduler().pingMs();

export type Target =
  | { kind: "claude"; model: string; base: string }
  | { kind: "provider"; model: string; name: string; provider: WorkerProvider };

export type Resolution = Target | { kind: "unknown"; model: string; routable: string[] };

/** Claude Code appends "[1m]" for the 1M-context variant; upstreams reject it. */
export function stripContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/i, "");
}

function isClaudeId(model: string): boolean {
  return /^claude-/.test(model) || loadConfig().router.claudeModelAliases.includes(model);
}

/** model id (suffix-free) → provider name, from enabled non-native providers. */
export function routingTable(providers: Record<string, WorkerProvider>): Map<string, string> {
  const table = new Map<string, string>();
  for (const [name, p] of Object.entries(providers)) {
    if (p.native || p.enabled === false || !p.baseUrl || p.protocol !== "anthropic" || (p.engine ?? "claude") !== "claude") continue;
    for (const id of Object.values(p.models)) {
      if (!id) continue;
      const bare = stripContextSuffix(id);
      if (!table.has(bare)) table.set(bare, name);
    }
  }
  return table;
}

/** model id (suffix-free) → every enabled routable provider declaring it, config order. */
export function routingCandidates(providers: Record<string, WorkerProvider>): Map<string, string[]> {
  const table = new Map<string, string[]>();
  for (const [name, p] of Object.entries(providers)) {
    if (p.native || p.enabled === false || !p.baseUrl || p.protocol !== "anthropic" || (p.engine ?? "claude") !== "claude") continue;
    for (const id of new Set(Object.values(p.models).filter((m): m is string => !!m).map(stripContextSuffix))) {
      const names = table.get(id) ?? [];
      names.push(name);
      table.set(id, names);
    }
  }
  return table;
}

/** Model ids declared by more than one enabled provider (the first used to win blindly). */
export function duplicateModelIds(providers: Record<string, WorkerProvider>): Array<{ model: string; providers: string[] }> {
  return [...routingCandidates(providers)].filter(([, n]) => n.length > 1).map(([model, names]) => ({ model, providers: names }));
}

export interface ResolveHints {
  /** provider the caller named (x-pai-provider); honoured when it declares the model */
  provider?: string;
  /** cached up/down of a provider; undefined = unknown */
  isUp?: (provider: string) => boolean | undefined;
  /** called with the model id and candidates when the id is ambiguous */
  onDuplicate?: (model: string, candidates: string[]) => void;
}

export function resolveModel(
  rawModel: string,
  providers: Record<string, WorkerProvider>,
  claudeBase: string = claudeUpstream(),
  hints: ResolveHints = {}
): Resolution {
  const model = stripContextSuffix(rawModel);
  if (isClaudeId(model)) return { kind: "claude", model, base: claudeBase };
  const table = routingTable(providers);
  let name = table.get(model);
  const cands = routingCandidates(providers).get(model) ?? [];
  if (cands.length > 1) {
    hints.onDuplicate?.(model, cands);
    if (hints.provider && cands.includes(hints.provider)) name = hints.provider;
    else name = cands.find((c) => hints.isUp?.(c) === true) ?? cands.find((c) => hints.isUp?.(c) !== false) ?? name;
  } else if (hints.provider && cands.includes(hints.provider)) name = hints.provider;
  if (!name) {
    // family prefixes: glm-* → glm, k3/kimi-* → kimi
    if (/^glm-/.test(model) && providers.glm) name = "glm";
    else if (/^(k3|kimi-)/.test(model) && providers.kimi) name = "kimi";
  }
  const p = name ? providers[name] : undefined;
  if (!name || !p) return { kind: "unknown", model, routable: ["claude-*", ...table.keys()] };
  return { kind: "provider", model, name, provider: p };
}

/** thinking blocks carry Anthropic signatures other providers reject. */
export function stripThinking(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  const cleaned = messages.map((m) => {
    if (!m || typeof m !== "object" || !Array.isArray((m as { content?: unknown }).content)) return m;
    const content = (m as { content: Array<{ type?: string }> }).content.filter(
      (b) => !(b && (b.type === "thinking" || b.type === "redacted_thinking"))
    );
    return { ...(m as object), content };
  });
  return { ...body, messages: cleaned };
}

/**
 * Claude Code opens the system prompt with `x-anthropic-billing-header: ...
 * cch=<hash of the body>; ...`, a block that differs on every request. It sits
 * in front of the whole conversation, so a prefix cache (local servers) can
 * reuse only what precedes it (the tool definitions, ~3-5k tokens) and
 * re-prefills everything after it each turn. Only Anthropic uses the header.
 */
export function stripBillingHeader(body: Record<string, unknown>): Record<string, unknown> {
  const system = body.system;
  if (!Array.isArray(system)) return body;
  const kept = system.filter(
    (b) => !(b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" && (b as { text: string }).text.startsWith("x-anthropic-billing-header:"))
  );
  return kept.length === system.length ? body : { ...body, system: kept };
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
    .join("\n");
}

/**
 * Claude Code appends a `role:"system"` message (environment + `<total_tokens>`
 * counter) after every user turn and keeps the old ones. A local server's chat
 * template hoists system messages into the single system block at the front, so
 * each turn grows that block by ~18 tokens and everything after it moves: the
 * prefix cache hits only up to the end of the system prompt (measured
 * 2026-10-17, 2638 of 5982 tokens, +18 per turn). Folding each one into the
 * user message before it keeps the history append-only; a leading one becomes
 * a user message.
 */
export function foldSystemMessages(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.some((m) => m && (m as { role?: unknown }).role === "system")) return body;
  const out: Array<{ role: string; content: unknown }> = [];
  for (const m of messages as Array<{ role: string; content: unknown }>) {
    if (!m || m.role !== "system") {
      out.push(m);
      continue;
    }
    const text = blockText(m.content);
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === "user") {
      const blocks = typeof prev.content === "string" ? [{ type: "text", text: prev.content }] : Array.isArray(prev.content) ? prev.content : [];
      out[out.length - 1] = { ...prev, content: [...blocks, { type: "text", text }] };
    } else {
      out.push({ role: "user", content: [{ type: "text", text }] });
    }
  }
  return { ...body, messages: out };
}

const isLoopback = isLoopbackUrl;

export interface Upstream {
  url: URL;
  headers: Record<string, string>;
  body: Buffer;
}

export interface RouterOptions {
  /**
   * Remote-address gate for the /v1 routes, set whenever the router listens
   * beyond loopback (router.bind): a request whose socket address fails it is
   * answered 403 before any routing — the inbound auth pass-through must not
   * leave the loopback+tailnet perimeter. Cockpit routes are handled before
   * this (they carry their own token, see src/router/cockpit-auth.ts).
   */
  /** Retry a local answer that carries an unparsed tool-call block once; default router.localToolCallRetry (true). */
  localToolCallRetry?: boolean;
  remoteAllowed?: (remoteAddress: string | undefined) => boolean;
  /** cached up/down of a provider (limits poll); breaks ties between providers declaring one model id */
  isUp?: (provider: string) => boolean | undefined;
  /**
   * A wrong-case tool name in the model's reply was rewritten to the declared
   * spelling. Default: router log line + a [model] record in tool-errors.jsonl.
   */
  onToolCaseFix?: (info: { from: string; to: string; model: string; provider: string; session?: string }) => void;
  /** managed instances of local models; default: local-instances.json, live pids only, cached 2 s. Registered endpoints (providers with characteristics) are merged in per request. */
  instances?: () => LocalInstance[];
  /** health of an endpoint (the probe cache); default: every endpoint is up. An unhealthy one is skipped like a dead pid. */
  healthy?: (i: LocalInstance) => boolean;
  /** the process-wide endpoint probe cache: the router refreshes it (fire and forget) and reads it, the cockpit reads the same instance. Takes precedence over `healthy`. */
  health?: EndpointHealth;
  /**
   * DNS-rebinding perimeter: the bind value (router.bind) and the extra Host
   * names (router.allowedHosts). When set, cockpit paths and state-changing
   * methods (POST/PUT/PATCH/DELETE) on any path are checked against them
   * before any handler runs (hostAllowed/originAllowed in cockpit-auth.ts):
   * a Host outside the allowed set or an Origin that does not match the Host
   * is answered 403. Proxy traffic (Host 127.0.0.1:<port>, no Origin) passes.
   */
  hosts?: { bind: string; extraHosts: string[] };
}

/** Catalogue shape endpointRegistry needs: which providers a managed model launches (cached 2 s). */
function launchedConfig(): () => LocalConfig {
  let at = 0;
  let cfg = { tiers: {} } as LocalConfig;
  return () => {
    if (Date.now() - at < 2000) return cfg;
    at = Date.now();
    cfg = { tiers: Object.fromEntries(tierProviderNames().map((p) => [p, { provider: p }])) } as unknown as LocalConfig;
    return cfg;
  };
}

/** Managed instances from the state file whose process is alive; cached 2 s so start/stop needs no router restart. */
function stateFileInstances(): () => LocalInstance[] {
  let at = 0;
  let rows: LocalInstance[] = [];
  return () => {
    if (Date.now() - at < 2000) return rows;
    at = Date.now();
    try {
      rows = readInstances(workersLogDir(readWorkersSection().workers)).filter((i) => {
        if (i.origin === "registered" || !i.pid) return false;
        try {
          process.kill(i.pid, 0);
          return true;
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === "EPERM";
        }
      });
    } catch {
      rows = [];
    }
    return rows;
  };
}

// accept-encoding dropped: usage is parsed from the plain response as it streams
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "accept-encoding", "content-encoding"]);
const AUTH = new Set(["authorization", "x-api-key"]);

/**
 * Decode a request body per its Content-Encoding. The router always parses the
 * body, so an unknown encoding is a 415, a corrupt one a 400. Every upstream
 * (loopback or cloud) then gets the plain re-serialized body: local servers
 * cannot read gzip, and plain is always valid for Anthropic, at the cost of
 * some upload bandwidth that the compression would have saved.
 */
export function decodeBody(
  raw: Buffer,
  encoding: string | string[] | undefined
): { ok: true; body: Buffer; encoded: boolean } | { ok: false; status: number; message: string } {
  const enc = (Array.isArray(encoding) ? encoding.join(",") : encoding ?? "").trim().toLowerCase();
  if (!enc || enc === "identity") return { ok: true, body: raw, encoded: false };
  const fn = enc === "gzip" || enc === "x-gzip" ? zlib.gunzipSync : enc === "deflate" ? zlib.inflateSync : enc === "br" ? zlib.brotliDecompressSync : null;
  if (!fn) return { ok: false, status: 415, message: `unsupported request Content-Encoding "${enc}"; the router accepts gzip, deflate, br or none` };
  try {
    return { ok: true, body: fn(raw), encoded: true };
  } catch (e) {
    return { ok: false, status: 400, message: `request body is not valid ${enc} data: ${(e as Error).message}` };
  }
}

function joinUrl(base: string, path: string): URL {
  return new URL(base.replace(/\/+$/, "") + path);
}

/** Build the upstream request, or an error status+message. */
export function prepare(
  path: string,
  inHeaders: http.IncomingHttpHeaders,
  rawBody: Buffer,
  providers: Record<string, WorkerProvider>,
  claudeBase: string = claudeUpstream(),
  hints: Omit<ResolveHints, "provider"> = {}
): { ok: true; up: Upstream; target: Target; requested: string } | { ok: false; status: number; message: string } {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { ok: false, status: 400, message: "invalid JSON body" };
  }
  if (typeof body.model !== "string") return { ok: false, status: 400, message: "missing model" };
  const named = inHeaders["x-pai-provider"];
  const res = resolveModel(body.model, providers, claudeBase, {
    ...hints,
    ...(typeof named === "string" && named ? { provider: named } : {}),
  });
  if (res.kind === "unknown") {
    return {
      ok: false,
      status: 400,
      message: `unknown model "${res.model}"; routable: ${res.routable.join(", ")}`,
    };
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(inHeaders)) {
    const lk = k.toLowerCase();
    if (HOP.has(lk) || v === undefined) continue;
    if (res.kind === "provider" && AUTH.has(lk)) continue;
    headers[lk] = Array.isArray(v) ? v.join(", ") : v;
  }
  let out: Record<string, unknown> = { ...body, model: res.model };
  let base: string;
  if (res.kind === "claude") {
    base = res.base;
  } else {
    out = stripBillingHeader(stripThinking(out));
    base = res.provider.baseUrl;
    if (isLoopback(base)) out = foldSystemMessages(out);
    let token: string | null;
    try {
      token = resolveProviderKey(res.provider);
    } catch (e) {
      return { ok: false, status: 502, message: (e as Error).message };
    }
    headers.authorization = `Bearer ${token ?? "local"}`;
  }
  if (process.env.PAI_ROUTER_DEBUG_PREFIX) {
    const h = prefixBlockHashes(out);
    if (h) process.stderr.write(`router prefix ${res.model} ${JSON.stringify(h)}\n`);
  }
  const buf = Buffer.from(JSON.stringify(out));
  headers["content-length"] = String(buf.length);
  return { ok: true, up: { url: joinUrl(base, path), headers, body: buf }, target: res, requested: body.model };
}

const blockHash = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 12);

/**
 * Per-block hashes of a conversation's first request (one message), so two
 * runs' prefixes can be diffed block by block. Null for later requests.
 * Enabled by PAI_ROUTER_DEBUG_PREFIX.
 */
export function prefixBlockHashes(body: Record<string, unknown>): { system: string; tools: string; user: string } | null {
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length !== 1) return null;
  return { system: blockHash(body.system), tools: blockHash(body.tools), user: blockHash((msgs[0] as { content?: unknown }).content) };
}

const MODELS_PATH = /^\/v1\/models(?:\/([^/?]+))?(\?.*)?$/;

/** Anthropic models-API entry for a routed id. */
export function modelEntry(id: string): { id: string; type: "model"; display_name: string; created_at: string } {
  return { id, type: "model", display_name: id, created_at: "2025-01-01T00:00:00Z" };
}

/** GET /v1/models[/id] for non-claude ids, from the routing table; null = not ours. */
export function modelsReply(
  path: string,
  providers: Record<string, WorkerProvider>
): { status: number; body: unknown } | null {
  const m = MODELS_PATH.exec(path);
  if (!m) return null;
  if (!m[1]) {
    const data = [...routingTable(providers).keys()].map(modelEntry);
    return { status: 200, body: { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null } };
  }
  const res = resolveModel(decodeURIComponent(m[1]), providers);
  if (res.kind === "provider") return { status: 200, body: modelEntry(res.model) };
  if (res.kind === "unknown") {
    return { status: 404, body: { type: "error", error: { type: "not_found_error", message: `model "${res.model}" not found` } } };
  }
  return null;
}

/** chars/4 over the request body, for providers without count_tokens. */
export function estimateTokens(rawBody: Buffer): number {
  return Math.ceil(rawBody.length / 4);
}

/** Log line plus a [model] tool-errors record, so `pai worker errors` keeps the data. */
function defaultToolCaseFix(log: (line: string) => void): NonNullable<RouterOptions["onToolCaseFix"]> {
  return (i) => {
    const text = `tool name case corrected: ${i.from} -> ${i.to}`;
    log(`${new Date().toISOString()} ${i.model} ${i.provider} ${text}`);
    recordToolError(workersLogDir(readWorkersSection().workers), {
      worker: i.session ?? "router",
      provider: i.provider,
      label: "router",
      tool: "router",
      text,
    });
  };
}

function isLocal(u: URL): boolean {
  return isLoopbackHostname(u.hostname);
}

/** The forwarded body parsed once more for the prompt-token count; null when it somehow is not JSON. */
function safeBody(raw: Buffer): Record<string, unknown> | null {
  try {
    return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A server on `routerHandler(...)`; takes exactly its parameters. */
export function createRouter(...args: Parameters<typeof routerHandler>): http.Server {
  return http.createServer(routerHandler(...args));
}

/**
 * The router's request handler, built separately from the server so a
 * non-loopback bind can put a second http.Server on the same handler (Node
 * refuses a second listen() on a listening server — ERR_SERVER_ALREADY_LISTEN)
 * while every entry point shares one BustDetector/GapTracker.
 */
export function routerHandler(
  loadProviders: () => Record<string, WorkerProvider> = () => withTierProviders(readWorkersSection().workers.providers),
  claudeBase: string = claudeUpstream(),
  log: (line: string) => void = (l) => process.stderr.write(l + "\n"),
  onUsage?: (row: UsageRow) => void,
  /** serves GET pages (the cockpit) before routing; true = handled */
  extra?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean,
  options?: RouterOptions
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const busts = new BustDetector();
  const gaps = new GapTracker();
  const warned = new Set<string>();
  const instancesOf = options?.instances ?? stateFileInstances();
  const launched = launchedConfig();
  const health = options?.health;
  const healthy = health ? (i: LocalInstance) => health.isHealthy(i) : options?.healthy ?? (() => true);
  /** requests routed to an instance and not yet released, by engine key */
  const held = new Map<string, number>();
  let warnedCompressed = false;
  const onDuplicate = (model: string, cands: string[]) => {
    if (warned.has(model)) return;
    warned.add(model);
    log(`${new Date().toISOString()} warning: model id ${model} is declared by several providers (${cands.join(", ")}); preferring one that is up`);
  };
  return (req, res) => {
    // DNS rebinding / cross-site: cockpit paths and state-changing methods are
    // checked before anything else (extra handlers included).
    const hosts = options?.hosts;
    if (hosts) {
      const path = (req.url ?? "/").split("?")[0]!;
      const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes((req.method ?? "GET").toUpperCase());
      if (isCockpitPath(path) || mutating) {
        const refuse = (error: string): void => {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error }));
          log(`${new Date().toISOString()} ${req.method ?? "-"} ${path} 403 ${error}`);
        };
        if (!hostAllowed(req.headers.host, hosts.bind, hosts.extraHosts)) return refuse("host not allowed");
        if (!originAllowed(req.headers.origin, req.headers.host)) return refuse("origin not allowed");
      }
    }
    if (extra?.(req, res)) return;
    const guard = options?.remoteAllowed;
    if (guard && !guard(req.socket.remoteAddress ?? undefined)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "permission_error", message: "pai router: /v1 is limited to loopback and the tailnet (100.64.0.0/10)" },
        })
      );
      log(`${new Date().toISOString()} ${req.method ?? "-"} ${(req.url ?? "/").split("?")[0]} 403 remote-not-allowed`);
      return;
    }
    if (req.method === "POST" && refuseUnlessLoopback(req, res, { allowHost: isTailnetOrLocalName })) return;
    const started = Date.now();
    const path = req.url ?? "/";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const fail = (status: number, message: string, model = "-", prov = "-") => {
        if (!res.headersSent) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
        } else res.end();
        log(`${new Date().toISOString()} ${model} ${prov} ${status} ${Date.now() - started}ms`);
      };
      const isModels = req.method === "GET" && MODELS_PATH.test(path);
      const isMessages = req.method === "POST" && /^\/v1\/messages(\/count_tokens)?(\?.*)?$/.test(path);
      if (!isModels && !isMessages) {
        return fail(404, `pai router: no route for ${req.method} ${path.split("?")[0]}`, `${req.method} ${path.split("?")[0]}`);
      }
      let providers: Record<string, WorkerProvider>;
      try {
        providers = loadProviders();
      } catch (e) {
        return fail(500, `workers config: ${(e as Error).message}`);
      }
      if (isModels) {
        const local = modelsReply(path, providers);
        if (local) {
          res.writeHead(local.status, { "content-type": "application/json" });
          res.end(JSON.stringify(local.body));
          log(`${new Date().toISOString()} GET ${path.split("?")[0]} local ${local.status} ${Date.now() - started}ms`);
          return;
        }
        // claude ids (and the list) pass to the anthropic upstream unchanged
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
        }
        const url = joinUrl(claudeBase, path);
        const ureq = (url.protocol === "https:" ? https : http).request(url, { method: "GET", headers }, (ures) => {
          const rh = { ...ures.headers };
          delete rh["transfer-encoding"];
          delete rh.connection;
          res.writeHead(ures.statusCode ?? 502, rh);
          ures.pipe(res);
          ures.on("end", () => log(`${new Date().toISOString()} GET ${path.split("?")[0]} anthropic ${ures.statusCode} ${Date.now() - started}ms`));
        });
        ureq.on("error", (e: NodeJS.ErrnoException) => fail(502, `upstream error: ${e.code ?? e.message} reaching ${claudeBase} (router.claudeUpstream in config.yaml)`, "GET models", ANTHROPIC_NATIVE));
        res.on("close", () => ureq.destroy());
        ureq.end();
        return;
      }
      const dec = decodeBody(Buffer.concat(chunks), req.headers["content-encoding"]);
      if (!dec.ok) return fail(dec.status, dec.message);
      if (dec.encoded && !warnedCompressed) {
        warnedCompressed = true;
        log(`${new Date().toISOString()} router: request bodies arrive ${String(req.headers["content-encoding"]).trim().toLowerCase()}-compressed`);
      }
      const prep = prepare(path, req.headers, dec.body, providers, claudeBase, {
        ...(options?.isUp ? { isUp: options.isUp } : {}),
        onDuplicate,
      });
      if (!prep.ok) return fail(prep.status, prep.message);
      const { up, target, requested } = prep;
      const prov = target.kind === "claude" ? ANTHROPIC_NATIVE : target.name;
      // scheduler / parker engine: one per running instance (n=1 keeps the bare provider name)
      let engine = prov;
      let instanceTag: string | undefined;
      let host: string | undefined;
      if (target.kind === "provider") {
        // every row resolves against the registry (managed + registered), then the least busy endpoint serves
        const registry = endpointRegistry(instancesOf(), providers, launched());
        if (health) void Promise.all([health.refresh(registry), health.refreshManaged(registry)]);
        const picked = pickInstance(prov, resolveSelector(target.name, registry).filter(healthy), (k) => held.get(k) ?? 0);
        if (picked) {
          const u = new URL(picked.url);
          up.url.protocol = u.protocol;
          up.url.host = u.host;
          engine = instanceEngineKey(picked);
          if (picked.origin === "managed") instanceTag = `#${instanceNumber(picked.id)}`;
          host = u.host;
          held.set(engine, (held.get(engine) ?? 0) + 1);
          let freed = false;
          const free = () => {
            if (freed) return;
            freed = true;
            held.set(engine, Math.max(0, (held.get(engine) ?? 1) - 1));
          };
          res.on("close", free);
        }
      }
      const isCount = path.includes("/count_tokens");
      const session = sessionTag(req.headers["x-claude-code-session-id"]);
      const sessionId = headerValue(req.headers["x-claude-code-session-id"], 64);
      const gap = onUsage && !isCount ? gaps.gap(sessionId, started) : undefined;
      const changed =
        onUsage && !isCount ? busts.check(session, fingerprint(JSON.parse(up.body.toString("utf8")))) : [];
      const record = (status: number, usage: Usage, timing: { ttftMs?: number; decodeMs?: number } = {}) => {
        if (!onUsage || isCount) return;
        const row: UsageRow = {
          ts: new Date().toISOString(),
          model: target.model,
          provider: prov,
          status,
          ms: Date.now() - started,
          ...usage,
          ...timing,
          bytes: up.body.length,
          cache: verdict(usage),
        };
        const needsInput = target.kind === "provider" && row.input_tokens === 0 && (row.output_tokens ?? 0) > 0 && status < 400;
        if (instanceTag) row.instance = instanceTag;
        if (host) row.host = host;
        if (session) row.session = session;
        if (sessionId) row.session_id = sessionId;
        row.requested_model = requested;
        row.routed_model = target.model;
        if (gap !== undefined) row.gap_s = gap;
        const ua = headerValue(req.headers["user-agent"]);
        const app = headerValue(req.headers["x-app"], 40);
        if (ua) row.user_agent = ua;
        if (app) row.x_app = app;
        if (changed.length) row.bust = changed;
        if (!needsInput) {
          onUsage(row);
          return;
        }
        void Promise.resolve(counted).then((c) => {
          if (c !== null) row.input_tokens = c;
          else {
            row.input_tokens = estimateTokens(up.body);
            row.input_estimated = true;
          }
          onUsage(row);
        });
      };
      // A loopback model server may not report its prompt-token count at all;
      // count it with the served model's tokenizer and fill the client stream
      // (InputTokensSse) and this row from that. Null count = unknown: the row
      // keeps the flagged chars/4 estimate, the stream stays untouched.
      const mayCount = target.kind === "provider" && !isCount && isLocal(up.url);
      const counted: Promise<number | null> = mayCount ? promptTokenCount(safeBody(up.body) ?? {}, target.model) : Promise.resolve(null);
      const mod = up.url.protocol === "https:" ? https : http;
      const forward = (release: (u?: Usage, opts?: { gate?: boolean }) => void): void => {
      const retryOn =
        target.kind === "provider" && !isCount && isLocal(up.url) && (options?.localToolCallRetry ?? loadConfig().router.localToolCallRetry) !== false;
      // one buffered POST to the same upstream (the retry)
      const again = (b: Buffer, cb: (status: number, headers: http.IncomingHttpHeaders, raw: Buffer) => void): void => {
        const q = mod.request(up.url, { method: "POST", headers: { ...up.headers, "content-length": String(b.length) } }, (x) => {
          const bits: Buffer[] = [];
          x.on("data", (c: Buffer) => bits.push(c));
          x.on("end", () => cb(x.statusCode ?? 502, x.headers, Buffer.concat(bits)));
          x.on("error", () => cb(502, {}, Buffer.alloc(0)));
        });
        q.on("error", () => cb(502, {}, Buffer.alloc(0)));
        res.on("close", () => q.destroy());
        q.end(b);
      };
      // Local 200 answers are held until complete so a damaged tool call never reaches the client as text.
      const gate = (ures0: http.IncomingMessage): void => {
        const ct = String(ures0.headers["content-type"] ?? "");
        if (!retryOn || ures0.statusCode !== 200 || ures0.headers["content-encoding"]) return respond(ures0);
        let pings: NodeJS.Timeout | undefined;
        if (/text\/event-stream/i.test(ct) && !res.headersSent) {
          const rh0 = { ...ures0.headers };
          delete rh0["transfer-encoding"];
          delete rh0.connection;
          delete rh0["keep-alive"];
          delete rh0["content-length"];
          res.writeHead(200, rh0);
          pings = setInterval(() => !res.writableEnded && res.write(`event: ping\ndata: {"type":"ping"}\n\n`), pingMs());
          pings.unref();
        }
        const bits: Buffer[] = [];
        ures0.on("data", (c: Buffer) => bits.push(c));
        ures0.on("error", () => {});
        ures0.on("end", () => {
          const first = Buffer.concat(bits);
          const deliver = (status: number, headers: http.IncomingHttpHeaders, raw: Buffer) => {
            if (pings) clearInterval(pings);
            const h = { ...headers };
            delete h["content-length"];
            const src = Readable.from([raw]) as unknown as http.IncomingMessage;
            src.statusCode = status;
            src.headers = h;
            respond(src);
          };
          const ans = readAnswer(first.toString("utf8"), ct);
          const degenerate = isDegenerate(ans, up.body);
          if (!isDamaged(ans) && !degenerate) return deliver(200, ures0.headers, first);
          const what = degenerate ? "degenerate-answer" : "malformed-tool-call";
          let nb: Buffer;
          try {
            nb = retryBody(up.body, ans.text, degenerate ? DEGENERATE_RETRY_TEXT : undefined);
          } catch {
            return deliver(200, ures0.headers, first);
          }
          again(nb, (status, headers, raw) => {
            const again2 = readAnswer(raw.toString("utf8"), String(headers["content-type"] ?? ""));
            const ok = status === 200 && !isDamaged(again2) && !isDegenerate(again2, up.body);
            log(`${new Date().toISOString()} ${what} retried provider=${prov} ${ok ? "ok" : "again"}`);
            if (ok) deliver(status, headers, raw);
            else deliver(200, ures0.headers, first);
          });
        });
      };
      const respond = (ures: http.IncomingMessage): void => {
        if (!isLocal(up.url)) upstreamStreak().success();
          if (isCount && target.kind === "provider" && (ures.statusCode ?? 0) >= 400) {
            // provider has no count_tokens: estimate instead of failing the client
            ures.resume();
            const raw = Buffer.concat(chunks);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ input_tokens: estimateTokens(raw) }));
            log(`${new Date().toISOString()} ${target.model} ${prov} count_tokens-estimate ${Date.now() - started}ms`);
            return;
          }
          const rh = { ...ures.headers };
          delete rh["transfer-encoding"];
          delete rh.connection;
          delete rh["keep-alive"];
          const sniff = (onUsage || scheduled) && !isCount ? new UsageSniffer(ures.headers["content-type"]) : undefined;
          if (sniff) ures.on("data", (c: Buffer) => sniff.push(c));
          if (res.headersSent && (ures.statusCode ?? 502) !== 200) {
            // queued stream: 200 + pings already went out, so an upstream failure travels as an SSE error event
            const bits: Buffer[] = [];
            ures.on("data", (c: Buffer) => bits.push(c));
            ures.on("end", () => {
              const text = Buffer.concat(bits).toString("utf8").trim();
              res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: text.slice(0, 500) || `upstream ${ures.statusCode}` } })}\n\n`);
              log(`${new Date().toISOString()} ${target.model} ${prov} ${ures.statusCode} ${Date.now() - started}ms`);
              release(sniff ? sniff.finish() : undefined);
            });
            return;
          }
          if (!res.headersSent) res.writeHead(ures.statusCode ?? 502, rh);
          const declared = isCount || ures.statusCode !== 200 ? [] : declaredToolNames(up.body);
          const plainSse = /text\/event-stream/i.test(String(ures.headers["content-type"] ?? "")) && !ures.headers["content-encoding"];
          const fixer =
            declared.length && plainSse
              ? new ToolCaseSse(declared, (from, to) =>
                  (options?.onToolCaseFix ?? defaultToolCaseFix(log))({ from, to, model: target.model, provider: prov, session })
                )
              : undefined;
          const fill = mayCount && plainSse ? new InputTokensSse(() => counted) : undefined;
          // ures -> [input fill] -> [tool-case fix] -> res
          if (fill && fixer) {
            ures.pipe(fill);
            fill.pipe(fixer);
            fixer.pipe(res);
          } else if (fill) {
            ures.pipe(fill).pipe(res);
          } else if (fixer) {
            ures.pipe(fixer).pipe(res);
          } else {
            ures.pipe(res);
          }
          ures.on("end", () => {
            log(`${new Date().toISOString()} ${target.model} ${prov} ${ures.statusCode} ${Date.now() - started}ms`);
            const ended = Date.now();
            const first = sniff?.firstContentAt;
            const usage = sniff ? sniff.finish() : emptyUsage();
            release(sniff ? usage : undefined, sniff?.buildCall ? { gate: true } : undefined);
            record(
              ures.statusCode ?? 502,
              usage,
              first !== undefined && (ures.statusCode ?? 502) < 400 ? { ttftMs: first - started, decodeMs: ended - first } : {}
            );
          });
      };
      const ureq = mod.request(up.url, { method: "POST", headers: up.headers }, gate);
      ureq.on("error", (e: NodeJS.ErrnoException) => {
        release();
        record(e.code === "ECONNREFUSED" ? 503 : 502, emptyUsage());
        if (!isLocal(up.url)) upstreamStreak().failure(e.code);
        if (target.kind === "provider" && isLocal(up.url) && e.code === "ECONNREFUSED") {
          return fail(
            503,
            `local model down — ECONNREFUSED reaching ${up.url.origin} (provider ${target.name} in workers.yaml); start it with pai worker local start <model>`,
            target.model,
            prov
          );
        }
        fail(
          502,
          `upstream error: ${e.code ?? e.message} reaching ${up.url.origin} (${target.kind === "claude" ? "router.claudeUpstream in config.yaml" : `provider ${target.name} in workers.yaml`})`,
          target.model,
          prov
        );
      });
      res.on("close", () => {
        release();
        ureq.destroy();
      });
      ureq.end(up.body);
      };
      // Local engine: one request in flight, the rest wait here (scheduler.ts). Any scheduler fault forwards directly.
      let scheduled = false;
      if (target.kind === "provider" && !isCount && isLocal(up.url) && schedEnabled()) {
        try {
          const sched = sharedScheduler();
          sharedParker().noteEngine(engine, up.url.origin);
          sched.idleHook ??= (e, w, n) => sharedParker().maybePark(e, w, n);
          const sess = headerValue(req.headers["x-pai-session"], 80) || "anon";
          const worker = headerValue(req.headers["x-pai-worker"], 80) || `conn:${sessionId?.slice(0, 8) ?? req.socket.remotePort ?? "?"}`;
          const hint = ["high", "normal", "low"].find((l) => l === headerValue(req.headers["x-pai-priority"], 10)) as "high" | "normal" | "low" | undefined;
          const streaming = safeBody(up.body)?.stream === true;
          let gone = false;
          let pings: NodeJS.Timeout | undefined;
          const stopPings = () => {
            if (pings) clearInterval(pings);
            pings = undefined;
          };
          if (streaming) {
            // keep Claude Code's stream-idle timers quiet while queued: 200 + SSE ping events
            pings = setInterval(() => {
              if (res.writableEnded || gone) return stopPings();
              if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
              res.write(`event: ping\ndata: {"type":"ping"}\n\n`);
            }, pingMs());
            pings.unref();
          }
          scheduled = true;
          sched
            .acquire(engine, sess, worker, {
              onAbort: (cb) =>
                res.on("close", () => {
                  gone = true;
                  cb();
                }),
            }, hint)
            .then(
              (ticket) => {
                stopPings();
                const go = () =>
                  forward((u, opts) => ticket.release(u ? { prefill: u.input_tokens > 0 ? newPrefill(u) : estimateTokens(up.body), decode: u.output_tokens } : undefined, opts));
                // a parked conversation is restored while this request holds the engine (active time), never failing it
                sharedParker().restoreIfParked(engine, worker, sched.slotHolder(engine)).then(go, go);
              },
              () => {
                stopPings();
                if (!gone) forward(() => {});
              }
            );
          return;
        } catch (e) {
          log(`${new Date().toISOString()} scheduler error, forwarding directly: ${(e as Error).message}`);
          scheduled = false;
        }
      }
      forward(() => {});
    });
  };
}
