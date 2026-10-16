/**
 * router.ts — local model router. One Claude Code session points its
 * ANTHROPIC_BASE_URL here and /model picks the provider: each POST
 * /v1/messages (and count_tokens) is routed by the body's `model`.
 *
 *   claude ids  → caveman (CLAUDE_UPSTREAM), inbound auth passed through
 *   other ids   → the workers.yaml provider that lists the model; inbound auth
 *                 dropped, the provider key injected as Authorization: Bearer
 *
 * Bodies and keys are never logged.
 */

import http from "node:http";
import https from "node:https";
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
import { readWorkersSection, resolveProviderKey, type WorkerProvider } from "../workers/config.js";

export const ROUTER_PORT = 8790;
export const CLAUDE_UPSTREAM = "http://127.0.0.1:8787/w/claude";

export type Target =
  | { kind: "claude"; model: string; base: string }
  | { kind: "provider"; model: string; name: string; provider: WorkerProvider };

export type Resolution = Target | { kind: "unknown"; model: string; routable: string[] };

/** Claude Code appends "[1m]" for the 1M-context variant; upstreams reject it. */
export function stripContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/i, "");
}

function isClaudeId(model: string): boolean {
  return /^claude-/.test(model) || ["sonnet", "opus", "haiku", "default", "opusplan"].includes(model);
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

export function resolveModel(
  rawModel: string,
  providers: Record<string, WorkerProvider>,
  claudeBase: string = CLAUDE_UPSTREAM
): Resolution {
  const model = stripContextSuffix(rawModel);
  if (isClaudeId(model)) return { kind: "claude", model, base: claudeBase };
  const table = routingTable(providers);
  let name = table.get(model);
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

export interface Upstream {
  url: URL;
  headers: Record<string, string>;
  body: Buffer;
}

// accept-encoding dropped: usage is parsed from the plain response as it streams
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "accept-encoding"]);
const AUTH = new Set(["authorization", "x-api-key"]);

function joinUrl(base: string, path: string): URL {
  return new URL(base.replace(/\/+$/, "") + path);
}

/** Build the upstream request, or an error status+message. */
export function prepare(
  path: string,
  inHeaders: http.IncomingHttpHeaders,
  rawBody: Buffer,
  providers: Record<string, WorkerProvider>,
  claudeBase: string = CLAUDE_UPSTREAM
): { ok: true; up: Upstream; target: Target; requested: string } | { ok: false; status: number; message: string } {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { ok: false, status: 400, message: "invalid JSON body" };
  }
  if (typeof body.model !== "string") return { ok: false, status: 400, message: "missing model" };
  const res = resolveModel(body.model, providers, claudeBase);
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
    out = stripThinking(out);
    base = res.provider.baseUrl;
    let token: string | null;
    try {
      token = resolveProviderKey(res.provider);
    } catch (e) {
      return { ok: false, status: 502, message: (e as Error).message };
    }
    headers.authorization = `Bearer ${token ?? "local"}`;
  }
  const buf = Buffer.from(JSON.stringify(out));
  headers["content-length"] = String(buf.length);
  return { ok: true, up: { url: joinUrl(base, path), headers, body: buf }, target: res, requested: body.model };
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

function isLocal(u: URL): boolean {
  return u.hostname === "127.0.0.1" || u.hostname === "localhost";
}

export function createRouter(
  loadProviders: () => Record<string, WorkerProvider> = () => readWorkersSection().workers.providers,
  claudeBase: string = CLAUDE_UPSTREAM,
  log: (line: string) => void = (l) => process.stderr.write(l + "\n"),
  onUsage?: (row: UsageRow) => void,
  /** serves GET pages (the cockpit) before routing; true = handled */
  extra?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean
): http.Server {
  const busts = new BustDetector();
  const gaps = new GapTracker();
  return http.createServer((req, res) => {
    if (extra?.(req, res)) return;
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
        ureq.on("error", (e: NodeJS.ErrnoException) => fail(502, `upstream error: ${e.code ?? e.message}`, "GET models", "anthropic"));
        res.on("close", () => ureq.destroy());
        ureq.end();
        return;
      }
      const prep = prepare(path, req.headers, Buffer.concat(chunks), providers, claudeBase);
      if (!prep.ok) return fail(prep.status, prep.message);
      const { up, target, requested } = prep;
      const prov = target.kind === "claude" ? "anthropic" : target.name;
      const isCount = path.includes("/count_tokens");
      const session = sessionTag(req.headers["x-claude-code-session-id"]);
      const sessionId = headerValue(req.headers["x-claude-code-session-id"], 64);
      const gap = onUsage && !isCount ? gaps.gap(sessionId, started) : undefined;
      const changed =
        onUsage && !isCount ? busts.check(session, fingerprint(JSON.parse(up.body.toString("utf8")))) : [];
      const record = (status: number, usage: Usage) => {
        if (!onUsage || isCount) return;
        const row: UsageRow = {
          ts: new Date().toISOString(),
          model: target.model,
          provider: prov,
          status,
          ms: Date.now() - started,
          ...usage,
          bytes: up.body.length,
          cache: verdict(usage),
        };
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
        onUsage(row);
      };
      const mod = up.url.protocol === "https:" ? https : http;
      const ureq = mod.request(
        up.url,
        { method: "POST", headers: up.headers },
        (ures) => {
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
          res.writeHead(ures.statusCode ?? 502, rh);
          const sniff = onUsage && !isCount ? new UsageSniffer(ures.headers["content-type"]) : undefined;
          if (sniff) ures.on("data", (c: Buffer) => sniff.push(c));
          ures.pipe(res);
          ures.on("end", () => {
            log(`${new Date().toISOString()} ${target.model} ${prov} ${ures.statusCode} ${Date.now() - started}ms`);
            record(ures.statusCode ?? 502, sniff ? sniff.finish() : emptyUsage());
          });
        }
      );
      ureq.on("error", (e: NodeJS.ErrnoException) => {
        record(e.code === "ECONNREFUSED" ? 503 : 502, emptyUsage());
        if (target.kind === "provider" && isLocal(up.url) && e.code === "ECONNREFUSED") {
          return fail(
            503,
            `local model down — start it with pai worker local <tier>`,
            target.model,
            prov
          );
        }
        fail(502, `upstream error: ${e.code ?? e.message}`, target.model, prov);
      });
      res.on("close", () => ureq.destroy());
      ureq.end(up.body);
    });
  });
}
