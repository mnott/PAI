/**
 * Tests for the uhp engine: request builder, strict SSE parser over fixture
 * transcripts, fold into claude-shaped events, vocabulary tables, config
 * validation, and runUhp/cancelUhp against a local fake HTTP server (no network).
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseProvider, type WorkerProvider } from "./config.js";
import {
  buildUhpHeaders,
  buildUhpRequest,
  cancelUhp,
  emptyUhpResult,
  foldUhpEvent,
  parseHarnessFlag,
  resolveHarnessProvider,
  runUhp,
  uhpProviderProblems,
  UhpProtocolError,
  UhpSseParser,
} from "./uhp.js";
import { modelRecord, resultToUhpStatus, uhpErrorReason, uhpStatusToResult, uhpStatusToState, workerStateToUhpStatus } from "./uhp-vocab.js";
import { uhpReport } from "./run/execute-uhp.js";
import { discoverUhp, discoverUhpVersion, httpErrorOf, uhpVersionWarning } from "./uhp.js";

const sse = (events: Array<Record<string, unknown>>): string =>
  events.map((e, i) => `data: ${JSON.stringify({ sequence_number: i, ...e })}\n\n`).join("");

const resp = (extra: Record<string, unknown> = {}) => ({ id: "resp_1", model: "m", metadata: { session_id: "sess_1" }, ...extra });

const completed = sse([
  { type: "response.created", response: resp() },
  { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "Bash", arguments: '{"command":"ls"}' } },
  { type: "response.output_item.done", item: { type: "function_call_output", call_id: "c1", output: "a.txt" } },
  { type: "response.output_text.delta", delta: "hel" },
  { type: "response.output_text.delta", delta: "lo" },
  { type: "response.output_text.done" },
  { type: "response.completed", response: resp({ files: [{ name: "a", download_url: "http://x/a" }] }) },
]);

function parseAll(text: string): ReturnType<typeof emptyUhpResult> {
  const p = new UhpSseParser();
  const r = emptyUhpResult();
  for (const e of p.push(text)) foldUhpEvent(e, r);
  p.finish();
  return r;
}

const provider = (baseUrl: string, extra: Partial<WorkerProvider> = {}): WorkerProvider =>
  ({ enabled: true, protocol: "anthropic", baseUrl, keyFile: null, key: "k-secret", models: { default: "m" }, env: {}, engine: "uhp", harnessId: "h1", ...extra }) as WorkerProvider;

describe("vocabulary", () => {
  it("maps status both ways", () => {
    expect(["completed", "incomplete", "failed", "cancelled", "weird"].map(uhpStatusToResult)).toEqual(["+", "~", "-", "!", "?"]);
    expect((["+", "~", "-", "!"] as const).map(resultToUhpStatus)).toEqual(["completed", "incomplete", "failed", "cancelled"]);
    expect(["done", "killed", "failed", "lost"].map(workerStateToUhpStatus)).toEqual(["completed", "cancelled", "failed", "failed"]);
    expect(["completed", "incomplete", "failed", "cancelled"].map(uhpStatusToState)).toEqual(["done", "done", "failed", "killed"]);
  });
  it("codes errors and records model fallback only when it differs", () => {
    expect(uhpErrorReason("rate_limited")).toBe("rate_limited");
    expect(uhpErrorReason("nope")).toBe("provider_error");
    expect(modelRecord("a", "a")).toEqual({});
    expect(modelRecord("a", "b", "why")).toEqual({ requestedModel: "a", modelFallback: true, modelFallbackReason: "why" });
  });
});

describe("request", () => {
  it("builds the body", () => {
    expect(buildUhpRequest("hi", { harnessId: "h", model: "m", previousResponseId: "r0", maxStep: 5, timeoutSeconds: 60 })).toEqual({
      input: "hi", stream: true, model: "m", previous_response_id: "r0", max_step: 5, timeout_seconds: 60, metadata: { harness_id: "h" },
    });
    expect(buildUhpRequest("hi")).toEqual({ input: "hi", stream: true, metadata: {} });
  });
  it("builds the headers", () => {
    const h = buildUhpHeaders(provider("http://x", { uhpProtocol: "2026-10-19" }), "w-1");
    expect(h.Authorization).toBe("Bearer k-secret");
    expect(h["Idempotency-Key"]).toBe("w-1");
    expect(h["UHP-Version"]).toBe("2026-10-19");
    expect(Object.keys(buildUhpHeaders(provider("http://x"), "w-1")).some((k) => /version/i.test(k))).toBe(false);
  });
});

describe("SSE parser", () => {
  it("folds a completed run into claude-shaped events", () => {
    const r = parseAll(completed);
    expect(r.result).toBe("+");
    expect(r.finalText).toBe("hello");
    expect(r.responseId).toBe("resp_1");
    expect(r.sessionId).toBe("sess_1");
    expect(r.tools).toBe(1);
    expect(r.downloadUrls).toEqual(["http://x/a"]);
    expect(r.events.map((e) => e.type)).toEqual(["assistant", "user", "assistant"]);
  });
  it("maps incomplete", () => {
    expect(parseAll(sse([{ type: "response.created", response: resp() }, { type: "response.incomplete", response: resp() }])).result).toBe("~");
  });
  it("maps failed with provider_error code", () => {
    const r = parseAll(sse([
      { type: "error", error: { code: "rate_limited", message: "slow down" } },
      { type: "response.failed", response: resp({ error: { code: "provider_error", message: "boom" } }) },
    ]));
    expect(r.result).toBe("-");
    expect(r.errorCode).toBe("provider_error");
    expect(r.errorMessage).toBe("boom");
  });
  it("maps a cancelled task: response.failed with status cancelled", () => {
    const r = parseAll(sse([
      { type: "response.created", response: resp({ status: "in_progress" }) },
      { type: "response.in_progress", response: resp({ status: "in_progress" }) },
      { type: "response.failed", response: resp({ status: "cancelled", error: null }) },
    ]));
    expect(r.status).toBe("cancelled");
    expect(r.result).toBe("!");
    expect(r.errorCode).toBe("cancelled");
  });
  it("the response status is authoritative over the event type", () => {
    const r = parseAll(sse([{ type: "response.failed", response: resp({ status: "incomplete" }) }]));
    expect(r.result).toBe("~");
  });
  it("response.cancelled is not a terminal event", () => {
    expect(() => parseAll(sse([{ type: "response.cancelled", response: resp() }]))).toThrow(/without a terminal/);
  });
  it("warns when the response has no metadata.session_id", () => {
    const r = parseAll(sse([{ type: "response.completed", response: { id: "resp_2", metadata: {} } }]));
    expect(r.warnings.join()).toMatch(/session_id/);
  });
  it("folds the text/part/arguments events without disturbing the result", () => {
    const r = parseAll(sse([
      { type: "response.created", response: resp() },
      { type: "response.in_progress", response: resp() },
      { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
      { type: "response.content_part.added", output_index: 0, content_index: 0 },
      { type: "response.output_text.delta", delta: "ok", item_id: "i", output_index: 0, content_index: 0 },
      { type: "response.output_text.done", text: "ok" },
      { type: "response.content_part.done" },
      { type: "response.function_call_arguments.delta", delta: "{" },
      { type: "response.function_call_arguments.done", arguments: "{}" },
      { type: "response.completed", response: resp({ status: "completed" }) },
    ]));
    expect(r.finalText).toBe("ok");
    expect(r.result).toBe("+");
  });
  it("rejects a sequence gap", () => {
    const bad = `data: ${JSON.stringify({ type: "response.created", sequence_number: 0 })}\n\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 2 })}\n\n`;
    expect(() => parseAll(bad)).toThrow(/sequence gap/);
  });
  it("rejects a stream not starting at 0", () => {
    expect(() => parseAll(`data: ${JSON.stringify({ type: "response.completed", sequence_number: 1 })}\n\n`)).toThrow(/expected 0/);
  });
  it("rejects malformed events", () => {
    expect(() => parseAll("data: {nope\n\n")).toThrow(UhpProtocolError);
    expect(() => parseAll(`data: ${JSON.stringify({ sequence_number: 0 })}\n\n`)).toThrow(/type/);
  });
  it("requires exactly one terminal", () => {
    expect(() => parseAll(sse([{ type: "response.created" }]))).toThrow(/without a terminal/);
    expect(() => parseAll(sse([{ type: "response.completed" }, { type: "response.failed" }]))).toThrow(/after terminal/);
  });
  it("requires a terminal after a non-terminal error", () => {
    expect(() => parseAll(sse([{ type: "error", error: { code: "timeout", message: "t" } }]))).toThrow(/not followed by a terminal/);
  });
  it("handles events split across chunks and CRLF", () => {
    const p = new UhpSseParser();
    const text = completed.replace(/\n/g, "\r\n");
    const got = [...p.push(text.slice(0, 50)), ...p.push(text.slice(50))];
    expect(got.length).toBe(7);
    p.finish();
  });
});

describe("report", () => {
  it("puts download urls and the status into the report notes", () => {
    const rep = uhpReport(parseAll(completed), "hello");
    expect(rep?.notes).toContain("files: http://x/a");
    const failed = parseAll(sse([{ type: "response.failed", response: resp({ error: { code: "quota_exhausted", message: "q" } }) }]));
    expect(uhpReport(failed, "")).toMatchObject({ result: "-", why: "quota_exhausted: q" });
  });
});

describe("config", () => {
  const base = { baseUrl: "http://h", models: { default: "m" }, engine: "uhp", harnessId: "h1", uhpProtocol: "2026-10-19" };
  it("parses uhp keys", () => {
    const p = parseProvider("u", base);
    expect(p.engine).toBe("uhp");
    expect(p.harnessId).toBe("h1");
    expect(p.uhpProtocol).toBe("2026-10-19");
  });
  it("reports problems", () => {
    expect(uhpProviderProblems("u", { ...parseProvider("u", base), keyFile: "~/k" })).toEqual([]);
    expect(uhpProviderProblems("u", parseProvider("u", base)).join()).toMatch(/no key/);
    expect(uhpProviderProblems("u", { ...parseProvider("u", base), baseUrl: "ftp://x", key: "k" }).join()).toMatch(/http/);
  });
  it("resolves --harness", () => {
    expect(parseHarnessFlag("uhp:abc")).toBe("abc");
    expect(() => parseHarnessFlag("x:abc")).toThrow();
    const ps = { a: parseProvider("a", base), b: parseProvider("b", { ...base, harnessId: "other" }) };
    expect(resolveHarnessProvider(ps, "other")).toBe("b");
    expect(() => resolveHarnessProvider(ps, "zzz")).toThrow(/no enabled/);
    expect(() => resolveHarnessProvider(ps, "h1", "nope")).toThrow(/not a uhp provider/);
  });
});

describe("fake server", () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  async function start(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("runs end to end with auth, idempotency, resume and cancel", async () => {
    const seen: Array<{ url: string; headers: Record<string, unknown>; body: string }> = [];
    const url = await start((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body });
        if (req.url === "/v1/responses") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(completed.slice(0, 40));
          res.end(completed.slice(40));
        } else if (req.url === "/v1/responses/resp_1/cancel") {
          res.writeHead(200).end("{}");
        } else res.writeHead(404).end();
      });
    });
    const p = provider(url);
    const r = await runUhp({ provider: p, workerId: "w-9", prompt: "do it", harnessId: "h1", model: "m", previousResponseId: "resp_0" });
    expect(r.result).toBe("+");
    expect(r.finalText).toBe("hello");
    expect(seen[0].headers.authorization).toBe("Bearer k-secret");
    expect(seen[0].headers["idempotency-key"]).toBe("w-9");
    expect(JSON.parse(seen[0].body)).toMatchObject({ stream: true, previous_response_id: "resp_0", metadata: { harness_id: "h1" } });
    expect(await cancelUhp(p, "resp_1", "w-9")).toBe(true);
    expect(seen[1].url).toBe("/v1/responses/resp_1/cancel");
  });

  it("turns an HTTP 429 into a rate_limited failure and a hung cancel into false within the timeout", async () => {
    const url = await start((req, res) => {
      if (req.url === "/v1/responses") res.writeHead(429).end("slow");
      // cancel: never answers
    });
    const r = await runUhp({ provider: provider(url), workerId: "w", prompt: "x" });
    expect(r.result).toBe("-");
    expect(r.errorCode).toBe("rate_limited");
    const t0 = Date.now();
    expect(await cancelUhp(provider(url), "r", "w", fetch, 300)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  const discovery = {
    object: "uhp.discovery", protocol: "uhp", versions: ["2026-10-19", "2026-10-04"], default_version: "2026-10-19",
    conformance_class: "full", capabilities: { streaming: true, sessions: true, plugins: false },
  };
  it("discovers the real body without auth and warns on a pin the server does not list", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const url = await start((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(discovery));
    });
    const d = await discoverUhp(provider(url));
    expect(d).toEqual({ default_version: "2026-10-19", versions: ["2026-10-19", "2026-10-04"], conformance_class: "full", capabilities: { streaming: true, sessions: true, plugins: false } });
    expect(await discoverUhpVersion(provider(url))).toBe("2026-10-19");
    expect(seen[0].authorization).toBeUndefined();
    expect(uhpVersionWarning("2026-09-12", d)).toMatch(/pins UHP 2026-09-12, server supports 2026-10-19, 2026-10-04/);
    expect(uhpVersionWarning("2026-10-04", d)).toBeNull();
    expect(uhpVersionWarning(undefined, d)).toBeNull();
    expect(await discoverUhp(provider("http://127.0.0.1:1"))).toBeNull();
  });

  it("rejects a discovery body that is not UHP", async () => {
    const url = await start((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: "2026-10-19", protocol: "other" }));
    });
    expect(await discoverUhp(provider(url))).toBeNull();
  });

  it("sends UHP-Version and records the answered version", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const url = await start((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "Content-Type": "text/event-stream", "UHP-Version": "2026-10-19" }).end(completed);
    });
    const r = await runUhp({ provider: provider(url, { uhpProtocol: "2026-10-19" }), workerId: "w", prompt: "x" });
    expect(seen[0]["uhp-version"]).toBe("2026-10-19");
    expect(r.uhpVersion).toBe("2026-10-19");
  });

  it("names the supported versions on unsupported_protocol_version", async () => {
    const url = await start((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json", "UHP-Version": "2026-10-19" }).end(JSON.stringify({
        error: { type: "invalid_request_error", code: "unsupported_protocol_version", message: "no", param: null, detail: { supported: ["2026-10-19"] } },
      }));
    });
    const r = await runUhp({ provider: provider(url, { uhpProtocol: "1.0" }), workerId: "w", prompt: "x" });
    expect(r.errorMessage).toContain("server supports: 2026-10-19");
    expect(r.uhpVersion).toBe("2026-10-19");
  });

  it("maps an unknown error code to its type", async () => {
    const url = await start((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { type: "rate_limit_error", code: "acme_slow_down", message: "m" } }));
    });
    const r = await runUhp({ provider: provider(url), workerId: "w", prompt: "x" });
    expect(r.errorCode).toBe("rate_limited");
    expect(httpErrorOf('{"error":{"type":"server_error","code":"c","message":"m"}}')).toMatchObject({ type: "server_error" });
  });

  it("requires a date as uhpProtocol", () => {
    const p = (v: string) => uhpProviderProblems("u", provider("http://h", { uhpProtocol: v })).join();
    expect(p("1.0")).toMatch(/uhpProtocol must be a date/);
    expect(p("2026-10-19")).not.toMatch(/uhpProtocol/);
  });

  it("reads the coded error body of a 409 session_busy", async () => {
    const url = await start((_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", code: "session_busy", message: "busy", param: null, detail: null } }));
    });
    const r = await runUhp({ provider: provider(url), workerId: "w", prompt: "x" });
    expect(r.errorCode).toBe("session_busy");
    expect(r.errorMessage).toBe("HTTP 409: busy");
    expect(httpErrorOf("not json")).toEqual({});
  });

  it("fails a stream with a gap", async () => {
    const url = await start((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "response.created", sequence_number: 0 })}\n\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 5 })}\n\n`);
    });
    await expect(runUhp({ provider: provider(url), workerId: "w", prompt: "x" })).rejects.toThrow(/sequence gap/);
  });
});
