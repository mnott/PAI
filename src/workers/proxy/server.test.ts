/**
 * Tests for the proxy server — an in-process proxy against a mock OpenAI
 * upstream (a plain node:http server on an ephemeral loopback port). No real
 * key, no claude, no osascript: the provider's keyFile is a temp file and the
 * mock upstream records what reached it.
 */

import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerProvider } from "../config.js";
import { createProxyServer, listenProxy } from "./server.js";

// ---------------------------------------------------------------------------
// Mock OpenAI upstream
// ---------------------------------------------------------------------------

interface UpstreamRecord {
  url: string;
  authorization: string;
  body: Record<string, unknown>;
}

function startMockUpstream(handler: (rec: UpstreamRecord) => { status: number; body: unknown }): Promise<{
  server: Server;
  port: number;
  seen: UpstreamRecord[];
}> {
  const seen: UpstreamRecord[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec: UpstreamRecord = {
        url: req.url ?? "/",
        authorization: String(req.headers.authorization ?? ""),
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      };
      seen.push(rec);
      const { status, body } = handler(rec);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port, seen });
    });
  });
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

// A provider with a temp key file — never a real key anywhere in here
const tmp = mkdtempSync(join(tmpdir(), "pai-proxy-test-"));
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, "key"), "test-token-only\n", { mode: 0o600 });
const keyFile = join(tmp, "key");

function openaiProvider(upstream: string): WorkerProvider {
  return {
    name: "mockoai",
    baseUrl: "",
    keyFile,
    models: { default: "mock-1", fast: "mock-1" },
    env: {},
    enabled: true,
    protocol: "openai",
    upstreamUrl: upstream,
  } as WorkerProvider;
}

function startProxy(providers: () => Record<string, WorkerProvider>): Promise<number> {
  const server = createProxyServer({ resolveProvider: providers });
  servers.push(server);
  return listenProxy(server, 0); // ephemeral port
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proxy server", () => {
  it("healthz answers ok", async () => {
    const port = await startProxy(() => ({}));
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("non-streaming: translates both directions and passes the keyFile token upstream", async () => {
    const up = await startMockUpstream(() => ({
      status: 200,
      body: {
        id: "chatcmpl-x",
        model: "mock-1",
        choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
    }));
    servers.push(up.server);
    const port = await startProxy(() => ({ mockoai: openaiProvider(`http://127.0.0.1:${up.port}/v1`) }));

    const res = await fetch(`http://127.0.0.1:${port}/mockoai/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "whatever-claude-sends",
        max_tokens: 32,
        system: "Reply with one word.",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type: string;
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.type).toBe("message");
    expect(body.content).toEqual([{ type: "text", text: "pong" }]);
    expect(body.stop_reason).toBe("stop_sequence");
    expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 1 });

    // the provider's model and keyFile token reached the mock upstream
    expect(up.seen[0].url).toBe(`/v1/chat/completions`);
    expect(up.seen[0].authorization).toBe("Bearer test-token-only");
    expect(up.seen[0].body.model).toBe("mock-1");
    expect(up.seen[0].body.messages).toEqual([
      { role: "system", content: "Reply with one word." },
      { role: "user", content: "ping" },
    ]);
  });

  it("streaming: OpenAI SSE chunks come back as Anthropic SSE events", async () => {
    const up = await startMockUpstream(() => ({
      status: 200,
      body: "not-used",
    }));
    servers.push(up.server);
    // swap in an SSE response for this upstream
    up.server.removeAllListeners("request");
    up.server.on("request", (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Bash", arguments: '{"command":"ls"}' } }] },
                finish_reason: "tool_calls",
              },
            ],
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    const port = await startProxy(() => ({ mockoai: openaiProvider(`http://127.0.0.1:${up.port}/v1`) }));

    const res = await fetch(`http://127.0.0.1:${port}/mockoai/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 8, stream: true, messages: [{ role: "user", content: "go" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = (await res.text()).replace(/msg_[a-z0-9]+/g, "msg_X");
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text_delta","text":"Hi"');
    expect(text).toContain('"type":"tool_use","id":"c1","name":"Bash"');
    expect(text).toContain('"partial_json":"{\\"command\\":\\"ls\\"}"');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).toContain("event: message_stop");
  });

  it("unknown provider: Anthropic-style 404 error JSON", async () => {
    const port = await startProxy(() => ({}));
    const res = await fetch(`http://127.0.0.1:${port}/nobody/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("non-openai provider refused with 400", async () => {
    const anthropicish = {
      name: "direct",
      baseUrl: "https://example.invalid/anthropic",
      keyFile: null,
      models: { default: "m", fast: "m" },
      env: {},
      enabled: true,
    } as unknown as WorkerProvider;
    const port = await startProxy(() => ({ direct: anthropicish }));
    const res = await fetch(`http://127.0.0.1:${port}/direct/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("not an openai-protocol provider");
  });

  it("upstream 429 maps to an Anthropic rate_limit_error", async () => {
    const up = await startMockUpstream(() => ({
      status: 429,
      body: { error: { message: "quota blown" } },
    }));
    servers.push(up.server);
    const port = await startProxy(() => ({ mockoai: openaiProvider(`http://127.0.0.1:${up.port}/v1`) }));
    const res = await fetch(`http://127.0.0.1:${port}/mockoai/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toBe("quota blown");
  });
});

// ---------------------------------------------------------------------------
// Monitor-only guard on replies
// ---------------------------------------------------------------------------

describe("proxy server guard tap", () => {
  const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const call = (args: string) => ({
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: args } }] }, finish_reason: "tool_calls" }],
  });

  async function run(mode: "off" | "monitor", upstreamBody: unknown, stream: boolean, contentType = "application/json") {
    const fired: Array<{ kind: string; tool?: string; input?: unknown; source?: string }> = [];
    const up = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": contentType });
        if (stream) {
          // split the body mid-line so chunk boundaries do not align with SSE lines
          const s = String(upstreamBody);
          res.write(s.slice(0, 40));
          setTimeout(() => res.end(s.slice(40)), 10);
        } else res.end(typeof upstreamBody === "string" ? upstreamBody : JSON.stringify(upstreamBody));
      });
    });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
    servers.push(up);
    const upPort = (up.address() as { port: number }).port;
    const server = createProxyServer({
      resolveProvider: () => ({ mockoai: openaiProvider(`http://127.0.0.1:${upPort}/v1`) }),
      guard: {
        mode,
        deps: {
          rules: () => [],
          evaluate: (e) => {
            fired.push(e as never);
            return { action: "allow" } as never;
          },
        },
      },
    });
    servers.push(server);
    const port = await listenProxy(server, 0);
    const res = await fetch(`http://127.0.0.1:${port}/mockoai/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 32, stream, messages: [{ role: "user", content: "x" }] }),
    });
    const text = (await res.text()).replace(/msg_[a-z0-9]+/g, "msg_X");
    await new Promise((r) => setTimeout(r, 50));
    return { text, fired };
  }

  it("non-streaming tool_calls: one proxy event, response unchanged by the tap", async () => {
    const body = call(JSON.stringify({ command: "git reset --hard" }));
    const off = await run("off", body, false);
    const on = await run("monitor", body, false);
    expect(off.fired).toHaveLength(0);
    expect(on.fired).toHaveLength(1);
    expect(on.fired[0]).toMatchObject({ kind: "tool_call", tool: "Bash", input: { command: "git reset --hard" }, source: "proxy" });
    expect(on.text).toBe(off.text);
  });

  it("streaming: split arguments accumulate into one event", async () => {
    const chunk = (tc: unknown, fin: string | null = null) => ({ choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: fin }] });
    const body = sse([
      chunk({ index: 0, id: "c1", type: "function", function: { name: "Bash", arguments: "" } }),
      chunk({ index: 0, function: { arguments: '{"command":"git re' } }),
      chunk({ index: 0, function: { arguments: 'set --hard"}' } }),
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const off = await run("off", body, true, "text/event-stream");
    const on = await run("monitor", body, true, "text/event-stream");
    expect(off.fired).toHaveLength(0);
    expect(on.fired).toHaveLength(1);
    expect(on.fired[0]).toMatchObject({ tool: "Bash", input: { command: "git reset --hard" }, source: "proxy" });
    expect(on.text).toBe(off.text);
  });

  it("invalid JSON arguments: no crash, raw string input", async () => {
    const r = await run("monitor", call("{not json"), false);
    expect(r.text).toContain("tool_use");
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0].input).toBe("{not json");
  });
});
