/**
 * Tests for the UHP server core: auth, discovery, harnesses/models, responses
 * (stream + non-stream equality), sessions, cancel, idempotency. A fake
 * WorkerRunner stands in for `pai worker run`; the SSE is checked with PAI's
 * own strict client parser (UhpSseParser). No network beyond a loopback port.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultWorkersConfig, parseProvider, type WorkersConfig } from "../workers/config.js";
import { eventsPath } from "../workers/paths.js";
import { loadStatus, saveStatus, type WorkerStatus } from "../workers/status.js";
import { UhpSseParser } from "../workers/uhp.js";
import { createToken, revokeToken } from "./auth.js";
import { conformanceClass, SERVER_CAPABILITIES } from "./discovery.js";
import { ResponseAssembler } from "./events.js";
import { createUhpServer } from "./server.js";
import { safeMessage } from "./responses.js";
import { type RunRequest, type WorkerRunner } from "./runner.js";

const TEXT_RUN = [
  { type: "system", subtype: "init", session_id: "s1" },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "all done" }] } },
  { type: "result", result: "R\nr=+\nz=ok", usage: { input_tokens: 3, output_tokens: 4 } },
];

class FakeRunner implements WorkerRunner {
  starts: RunRequest[] = [];
  cancels: string[] = [];
  /** lines a started worker writes; null = the worker stays running */
  script: object[] | null = TEXT_RUN;
  finalState: WorkerStatus["state"] = "done";
  finalExtra: Partial<WorkerStatus> = {};
  constructor(private readonly logDir: string) {}
  private status(id: string, state: WorkerStatus["state"], extra: Partial<WorkerStatus> = {}): void {
    saveStatus(this.logDir, {
      id, pid: 1, label: "x", cwd: "/tmp", term: "", provider: "p1", model: "m1", state, started: "t", updated: "t",
      turns: 0, tools: 0, last: "", rc: null, secs: null, ...extra,
    });
  }
  async start(req: RunRequest): Promise<void> {
    this.starts.push(req);
    this.status(req.workerId, "running");
    const lines = this.script;
    if (!lines) return;
    setTimeout(() => {
      for (const l of lines) appendFileSync(eventsPath(this.logDir, req.workerId), JSON.stringify(l) + "\n");
      this.status(req.workerId, this.finalState, { rc: 0, ...this.finalExtra });
    }, 80);
  }
  async cancel(id: string): Promise<void> {
    this.cancels.push(id);
  }
}

let dir: string;
let logDir: string;
let server: Server;
let base: string;
let token: string;
let runner: FakeRunner;
let config: WorkersConfig;
let tokensPath: string;

function mkConfig(): WorkersConfig {
  const c = defaultWorkersConfig();
  c.providers = {
    p1: parseProvider("p1", { baseUrl: "http://127.0.0.1:9", models: { default: "m1", fast: "m1f" }, keyFile: null }),
  };
  c.classes = { implement: "p1" };
  c.active = "p1";
  return c;
}

async function boot(): Promise<void> {
  server = createUhpServer({
    stateDir: join(dir, "state"), tokensPath, config: () => config, logDir, runner, probe: async () => true,
    keepAliveMs: 60, pollMs: 15, version: "9.9.9",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "uhp-srv-"));
  logDir = join(dir, "logs");
  mkdirSync(logDir, { recursive: true });
  tokensPath = join(dir, "tokens.json");
  token = createToken(tokensPath, "t").token;
  runner = new FakeRunner(logDir);
  config = mkConfig();
  await boot();
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}, tok: string | null = token) =>
  fetch(base + path, { ...init, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), "Content-Type": "application/json", ...(init.headers as object) } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => api(path, { method: "POST", body: JSON.stringify(body), headers });

async function harnessId(): Promise<string> {
  return ((await (await api("/v1/harnesses")).json()) as { harnesses: Array<{ id: string }> }).harnesses[0]!.id;
}

describe("discovery, version, auth, errors", () => {
  it("serves discovery without a token, with all 14 capabilities explicit", async () => {
    const r = await api("/v1/uhp", {}, null);
    expect(r.status).toBe(200);
    expect(r.headers.get("uhp-version")).toBe("2026-10-19");
    const j = (await r.json()) as Record<string, any>;
    expect(j).toMatchObject({ object: "uhp.discovery", protocol: "uhp", default_version: "2026-10-19", conformance_class: "core", implementation: { name: "PAI", version: "9.9.9" } });
    expect(Object.keys(j.capabilities)).toHaveLength(14);
    expect(j.capabilities).toMatchObject({ streaming: true, idempotency: true, files_input: false, harness_management: false });
  });
  it("computes the class from capabilities", () => {
    expect(conformanceClass(SERVER_CAPABILITIES)).toBe("core");
    expect(conformanceClass({ ...SERVER_CAPABILITIES, files_input: true, files_output: true, session_listing: true })).toBe("extended");
  });
  it("honours a supported version and refuses an unsupported one with the list", async () => {
    expect((await api("/v1/uhp", { headers: { "UHP-Version": "2026-10-19" } }, null)).headers.get("uhp-version")).toBe("2026-10-19");
    const r = await api("/v1/uhp", { headers: { "UHP-Version": "1999-01-01" } }, null);
    expect(r.status).toBe(400);
    expect(r.headers.get("uhp-version")).toBe("2026-10-19");
    expect(((await r.json()) as any).error).toMatchObject({ code: "unsupported_protocol_version", detail: { supported: ["2026-10-19"] } });
  });
  it("401s without, with a bad, and with a revoked token (same body for the last two)", async () => {
    expect((await api("/v1/harnesses", {}, null)).status).toBe(401);
    const bad = await api("/v1/harnesses", {}, "nope");
    expect(bad.status).toBe(401);
    const badBody = await bad.json();
    expect(badBody).toMatchObject({ error: { type: "authentication_error", code: "invalid_credential" } });
    revokeToken(tokensPath, "t");
    const revoked = await api("/v1/harnesses");
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual(badBody);
  });
  it("answers an unknown harness with the 404 envelope and the version header", async () => {
    const r = await api("/v1/harnesses/chrn_nosuch");
    expect(r.status).toBe(404);
    expect(r.headers.get("uhp-version")).toBe("2026-10-19");
    const e = ((await r.json()) as any).error;
    expect(e).toMatchObject({ type: "invalid_request_error", code: "harness_not_found", param: null, detail: null });
    expect(e.message).not.toMatch(/\n\s+at /);
  });
  it("sends the version header on an unknown route and an unauthenticated error", async () => {
    expect((await api("/v1/nope", {}, null)).headers.get("uhp-version")).toBe("2026-10-19");
  });
});

describe("harnesses and models", () => {
  it("projects provider x class as harnesses with a stable id", async () => {
    const list = (await (await api("/v1/harnesses")).json()) as { harnesses: Array<Record<string, any>> };
    expect(list.harnesses).toHaveLength(1);
    const h = list.harnesses[0]!;
    expect(h).toMatchObject({ object: "harness", name: "p1/implement", base: "pai", defaultModel: "m1", mcpServers: [], disabledTools: [] });
    expect(h.id).toMatch(/^chrn_[0-9a-f]{32}$/);
    const again = (await (await api(`/v1/harnesses/${h.id}`)).json()) as Record<string, any>;
    expect(again.id).toBe(h.id);
  });
  it("lists models with computed availability", async () => {
    const id = await harnessId();
    const m = (await (await api(`/v1/harnesses/${id}/models`)).json()) as Record<string, any>;
    expect(m).toMatchObject({ harness_id: id, backend: "claude", default: "m1", fallback: "m1" });
    expect(m.models.map((x: any) => x.id)).toEqual(["m1", "m1f"]);
    expect(m.models.every((x: any) => x.available === true)).toBe(true);
    await new Promise((r) => server.close(r));
    server = createUhpServer({ stateDir: join(dir, "state"), tokensPath, config: () => config, logDir, runner, probe: async () => false });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cat = (await (await api("/v1/models")).json()) as any;
    expect(cat.backends.claude.default).toBe("m1");
    expect(cat.backends.claude.models.every((x: any) => x.available === false)).toBe(true);
  });
});

describe("responses", () => {
  it("runs non-streaming to a completed Response with prefixed ids, session and null-or-real usage", async () => {
    const r = await post("/v1/responses", { input: "do it" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, any>;
    expect(j).toMatchObject({ object: "response", status: "completed", model: "m1", error: null, store: true, previous_response_id: null });
    expect(j.id).toMatch(/^resp_/);
    expect(j.metadata.session_id).toMatch(/^hsess/);
    expect(j.usage).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    expect(j.output.map((o: any) => o.type)).toEqual(["reasoning", "function_call", "function_call_output", "message"]);
    expect(runner.starts[0]).toMatchObject({ prompt: "do it", provider: "p1", className: "implement" });
  });
  it("streams a gapless, single-terminal sequence that PAI's strict parser accepts, with output equal to the non-stream", async () => {
    const ns = (await (await post("/v1/responses", { input: "x" })).json()) as any;
    const r = await post("/v1/responses", { input: "x", stream: true });
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const p = new UhpSseParser();
    const evs = p.push(await r.text());
    const term = p.finish();
    expect(evs[0]!.type).toBe("response.created");
    expect(evs[1]!.type).toBe("response.in_progress");
    expect(term.type).toBe("response.completed");
    expect(evs.filter((e) => e.type.startsWith("response.output_text.delta"))).toHaveLength(1);
    expect((term.response as any).output).toEqual(ns.output);
    expect((term.response as any).status).toBe("completed");
  });
  it("is progressive: the first event arrives before the worker finishes, and keep-alives flow", async () => {
    runner.script = null;
    const r = await post("/v1/responses", { input: "slow", stream: true });
    const reader = r.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("response.created");
    let seen = "";
    for (let i = 0; i < 20 && !seen.includes("keep-alive"); i++) seen += new TextDecoder().decode((await reader.read()).value);
    expect(seen).toContain(": keep-alive");
    await reader.cancel();
  });
  it("reports in_progress (never running) for a background task, then completed", async () => {
    runner.script = null;
    const j = (await (await post("/v1/responses", { input: "bg", background: true })).json()) as any;
    expect(j.status).toBe("in_progress");
    const got = (await (await api(`/v1/responses/${j.id}`)).json()) as any;
    expect(got.status).toBe("in_progress");
  });
  it("accepts reserved fields and reports them in metadata.ignored_fields; none sent -> none reported", async () => {
    const j = (await (await post("/v1/responses", { input: "x", tools: [], include: [], weird: 1 })).json()) as any;
    expect(j.status).toBe("completed");
    expect(j.metadata.ignored_fields).toEqual(["tools", "include", "weird"]);
    const k = (await (await post("/v1/responses", { input: "x" })).json()) as any;
    expect(k.metadata.ignored_fields).toBeUndefined();
  });
  it("maps max_step, timeout_seconds and instructions to the worker request", async () => {
    await post("/v1/responses", { input: "x", max_step: 3, timeout_seconds: 90, instructions: "be brief" });
    expect(runner.starts[0]).toMatchObject({ maxTurns: 3, timeoutSeconds: 90, instructions: "be brief" });
  });
  it("validates input", async () => {
    for (const body of [{}, { input: 5 }, { input: "" }, { input: [{ type: "input_file", file_id: "f" }] }, { input: "x", max_step: 0 }]) {
      const r = await post("/v1/responses", body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.code).toBe("invalid_input");
    }
    const bad = await api("/v1/responses", { method: "POST", body: "{nope" });
    expect(bad.status).toBe(400);
  });
  it("takes item[] input and returns it from input_items", async () => {
    const j = (await (await post("/v1/responses", { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] })).json()) as any;
    expect(runner.starts[0]!.prompt).toBe("hi");
    const items = (await (await api(`/v1/responses/${j.id}/input_items`)).json()) as any;
    expect(items.data).toHaveLength(1);
  });
  it("refuses an unknown model with 422 model_unavailable and an unknown harness with 404", async () => {
    const m = await post("/v1/responses", { input: "x", model: "ghost" });
    expect(m.status).toBe(422);
    expect(((await m.json()) as any).error.code).toBe("model_unavailable");
    expect(runner.starts).toHaveLength(0);
    const h = await post("/v1/responses", { input: "x", metadata: { harness_id: "chrn_zz" } });
    expect(h.status).toBe(404);
    const ok = (await (await post("/v1/responses", { input: "x", model: "m1f" })).json()) as any;
    expect(ok.model).toBe("m1f");
  });
  it("scopes responses per principal: another token gets 404", async () => {
    const j = (await (await post("/v1/responses", { input: "x" })).json()) as any;
    const other = createToken(tokensPath, "other").token;
    expect((await api(`/v1/responses/${j.id}`, {}, other)).status).toBe(404);
    expect((await api(`/v1/responses/${j.id}/cancel`, { method: "POST" }, other)).status).toBe(404);
    expect(((await (await api("/v1/responses/resp_nosuch")).json()) as any).error.code).toBe("response_not_found");
  });
  it("DELETE removes a finished response and refuses to cancel a running one", async () => {
    const j = (await (await post("/v1/responses", { input: "x" })).json()) as any;
    expect((await api(`/v1/responses/${j.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/v1/responses/${j.id}`)).status).toBe(404);
    runner.script = null;
    const run = (await (await post("/v1/responses", { input: "y", background: true })).json()) as any;
    expect((await api(`/v1/responses/${run.id}`, { method: "DELETE" })).status).toBe(409);
    expect(runner.cancels).toEqual([]);
  });
});

describe("status mapping", () => {
  const cases: Array<[string, object[], WorkerStatus["state"], Partial<WorkerStatus>, string, string?]> = [
    ["failed worker", [], "failed", { last: "boom at /Users/x/secret/file.ts" }, "failed"],
    ["killed", [], "killed", {}, "cancelled"],
    ["deadline", [], "failed", { timedOut: true }, "incomplete", "timeout"],
    ["loop stop", [], "failed", { loopStopped: true }, "incomplete", "loop_stopped"],
    ["max turns", [{ type: "result", subtype: "error_max_turns", result: "" }], "done", {}, "incomplete", "max_step"],
    ["AG2 r=-", [{ type: "result", result: "R\nr=-\ny=nope" }], "done", {}, "failed"],
    ["AG2 r=~", [{ type: "result", result: "R\nr=~\ny=more" }], "done", {}, "incomplete", "budget"],
  ];
  for (const [name, lines, state, extra, status, reason] of cases) {
    it(name, async () => {
      runner.script = lines;
      runner.finalState = state;
      runner.finalExtra = extra;
      const j = (await (await post("/v1/responses", { input: "x" })).json()) as any;
      expect(j.status).toBe(status);
      if (reason) expect(j.incomplete_details.reason).toBe(reason);
      if (status === "failed") {
        expect(j.error.type).toBe("harness_error");
        expect(j.error.message).not.toContain("/Users");
      }
    });
  }
  it("safeMessage strips paths, urls, secrets and stack frames", () => {
    expect(safeMessage("fail in /Users/a/b/c.ts see https://h.example/x?k=1 at fn (/x/y.js:1:2)")).not.toMatch(/Users|h\.example|y\.js/);
  });
});

describe("sessions", () => {
  it("continues a session via previous_response_id on the same harness, and refuses a mismatch and a busy session", async () => {
    runner.script = null;
    const a = (await (await post("/v1/responses", { input: "one", background: true })).json()) as any;
    const busy = await post("/v1/responses", { input: "two", previous_response_id: a.id });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as any).error).toMatchObject({ code: "session_busy", detail: null });
    // finish the first worker
    appendFileSync(eventsPath(logDir, runner.starts[0]!.workerId), JSON.stringify({ type: "result", result: "ok" }) + "\n");
    saveStatus(logDir, { ...loadStatus(logDir, runner.starts[0]!.workerId)!, state: "done" });
    runner.script = TEXT_RUN;
    const b = (await (await post("/v1/responses", { input: "two", previous_response_id: a.id, model: "m1f" })).json()) as any;
    expect(b.metadata.session_id).toBe(a.metadata.session_id);
    expect(b.previous_response_id).toBe(a.id);
    expect(runner.starts[1]).toMatchObject({ resumeOf: runner.starts[0]!.workerId, model: "m1f" });
    const mm = await post("/v1/responses", { input: "x", previous_response_id: a.id, metadata: { harness_id: "chrn_other" } });
    expect(mm.status).toBe(409);
    expect(((await mm.json()) as any).error.code).toBe("harness_mismatch");
    const gone = await post("/v1/responses", { input: "x", previous_response_id: "resp_nope" });
    expect(((await gone.json()) as any).error.code).toBe("response_not_found");
  });
});

describe("cancel", () => {
  it("answers within 1 s with a cancelled response, asks the runner to stop, keeps partial output; repeat and terminal are no-ops", async () => {
    runner.script = null;
    const a = (await (await post("/v1/responses", { input: "long", background: true })).json()) as any;
    const t0 = Date.now();
    const c = (await (await api(`/v1/responses/${a.id}/cancel`, { method: "POST" })).json()) as any;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(c.status).toBe("cancelled");
    expect(runner.cancels).toEqual([runner.starts[0]!.workerId]);
    const again = (await (await api(`/v1/responses/${a.id}/cancel`, { method: "POST" })).json()) as any;
    expect(again.status).toBe("cancelled");
    expect(runner.cancels).toHaveLength(1);
    runner.script = TEXT_RUN;
    const done = (await (await post("/v1/responses", { input: "q" })).json()) as any;
    const noop = (await (await api(`/v1/responses/${done.id}/cancel`, { method: "POST" })).json()) as any;
    expect(noop.status).toBe("completed");
  });
  it("ends an open stream with response.failed carrying status cancelled", async () => {
    runner.script = null;
    const r = await post("/v1/responses", { input: "long", stream: true });
    const text = r.text();
    await new Promise((res) => setTimeout(res, 80));
    const id = (await new Promise<string>((res) => res(runner.starts[0]!.workerId)));
    void id;
    const recs = (await import("node:fs")).readdirSync(join(dir, "state", "responses"));
    await api(`/v1/responses/${recs[0]!.slice(0, -5)}/cancel`, { method: "POST" });
    const p = new UhpSseParser();
    p.push(await text);
    const term = p.finish();
    expect(term.type).toBe("response.failed");
    expect((term.response as any).status).toBe("cancelled");
  });
  it("cancels by session id", async () => {
    runner.script = null;
    const a = (await (await post("/v1/responses", { input: "long", background: true })).json()) as any;
    const c = (await (await api(`/v1/sessions/${a.metadata.session_id}/cancel`, { method: "POST" })).json()) as any;
    expect(c.status).toBe("cancelled");
    expect((await api("/v1/sessions/hsessnone/cancel", { method: "POST" })).status).toBe(404);
  });
});

describe("idempotency", () => {
  it("replays the first result without a second worker, for streaming and not", async () => {
    const a = (await (await post("/v1/responses", { input: "x" }, { "Idempotency-Key": "k1" })).json()) as any;
    const b = (await (await post("/v1/responses", { input: "x" }, { "Idempotency-Key": "k1" })).json()) as any;
    expect(b.id).toBe(a.id);
    const body = { input: "x", stream: true };
    const s1 = await (await post("/v1/responses", body, { "Idempotency-Key": "k1s" })).text();
    const s2 = await (await post("/v1/responses", body, { "Idempotency-Key": "k1s" })).text();
    const data = (t: string) => t.split("\n\n").filter((x) => x.startsWith("data:")); expect(data(s2)).toEqual(data(s1));
    expect(s2).toContain("response.completed");
    expect(runner.starts).toHaveLength(2);
  });
  it("runs once for concurrent requests with one key", async () => {
    const rs = await Promise.all([1, 2, 3].map(() => post("/v1/responses", { input: "x" }, { "Idempotency-Key": "race" })));
    const ids = await Promise.all(rs.map(async (r) => ((await r.json()) as any).id));
    expect(new Set(ids).size).toBe(1);
    expect(runner.starts).toHaveLength(1);
  });
  it("409s the same key with a different body", async () => {
    await post("/v1/responses", { input: "x" }, { "Idempotency-Key": "k2" });
    const r = await post("/v1/responses", { input: "other" }, { "Idempotency-Key": "k2" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe("invalid_input");
    expect(runner.starts).toHaveLength(1);
  });
  it("lets a failed start be retried under the same key", async () => {
    const orig = runner.start.bind(runner);
    runner.start = async () => {
      throw new Error("no capacity /secret/path");
    };
    const f = await post("/v1/responses", { input: "x" }, { "Idempotency-Key": "k3" });
    expect(f.status).toBe(503);
    expect(JSON.stringify(await f.json())).not.toContain("/secret");
    runner.start = orig;
    expect((await post("/v1/responses", { input: "x" }, { "Idempotency-Key": "k3" })).status).toBe(200);
  });
});

describe("ResponseAssembler", () => {
  it("produces the same output for a replay of the same lines (golden)", () => {
    const f = { id: "resp_1", model: "m", sessionId: "hsess1", previousResponseId: null, store: true, createdAt: 1, metadata: {} };
    const a = new ResponseAssembler(f);
    const types = TEXT_RUN.flatMap((l) => a.push(l as any)).map((e) => e.type);
    expect(types).toEqual([
      "response.output_item.added", "response.reasoning_summary_part.added", "response.reasoning_summary_text.delta", "response.reasoning_summary_part.done", "response.output_item.done",
      "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done",
      "response.output_item.added", "response.output_item.done",
      "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done",
    ]);
    expect(a.terminal({ status: "cancelled" }).type).toBe("response.failed");
    expect(a.terminal({ status: "incomplete" }).type).toBe("response.incomplete");
  });
});

void writeFileSync;
