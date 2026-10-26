import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { setSchedConfigSource, DEFAULT_SCHED } from "./scheduler.js";
import { createRouter } from "./router.js";
import type { WorkerProvider } from "../workers/config.js";

const closers: Array<() => void> = [];
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  setSchedConfigSource(() => DEFAULT_SCHED);
  delete process.env.PAI_ROUTER_PING_MS;
});

/** One engine slot: request A holds the engine until `gate`; B queues and gets keepalives. */
async function setup(path: string, body: (stream: boolean) => string, reply: (stream: boolean) => { ct: string; body: string }) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let active = 0;
  const up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      active++;
      void gate.then(() => {
        active--;
        const r = reply(active >= 0);
        res.writeHead(200, { "content-type": r.ct });
        res.end(r.body);
      });
    });
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const provider = {
    enabled: true, protocol: "anthropic", baseUrl: `http://127.0.0.1:${(up.address() as AddressInfo).port}`,
    keyFile: null, models: { default: "qwen-test" }, env: {},
  } as unknown as WorkerProvider;
  const router = createRouter(() => ({ eng: provider }), "http://127.0.0.1:1", () => {}, () => {});
  await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
  closers.push(() => { router.close(); up.close(); });
  const port = (router.address() as AddressInfo).port;
  const call = (session: string, worker: string, onData?: (text: string) => void) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const rq = http.request(
        { host: "127.0.0.1", port, path, method: "POST", headers: { "x-pai-provider": "eng", "x-pai-session": session, "x-pai-worker": worker } },
        (res) => {
          let text = "";
          res.on("data", (c) => { text += c; onData?.(text); });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        }
      );
      rq.on("error", reject);
      rq.end(body(true));
    });
  return { call, release };
}

const until = async (ok: () => boolean) => { while (!ok()) await new Promise((r) => setTimeout(r, 5)); };

/** Standard SSE framing: every message ends with a blank line; each line is a
 *  comment (`:`), a field (`event:`/`data:`), or empty. */
function parseSse(text: string): Array<{ event?: string; data?: string }> {
  const msgs: Array<{ event?: string; data?: string }> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event: string | undefined;
    let data: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const m = /^(event|data):\s*(.*)$/.exec(line);
      if (!m) throw new Error(`not an SSE line: ${JSON.stringify(line)}`);
      if (m[1] === "event") event = m[2];
      else data = (data ? data + "\n" : "") + m[2];
    }
    if (data !== undefined || event !== undefined) msgs.push({ event, data });
  }
  return msgs;
}

const chatChunk = (content: string, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completions.chunk", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

describe("queued-stream keepalives by wire format", () => {
  it("chat/completions: only SSE-comment keepalives while queued, then valid chunks a standard SSE parser accepts", async () => {
    process.env.PAI_ROUTER_PING_MS = "25";
    const t = await setup(
      "/v1/chat/completions",
      (stream) => JSON.stringify({ model: "qwen-test", stream, messages: [{ role: "user", content: "hi" }] }),
      () => ({ ct: "text/event-stream", body: chatChunk("hello", "stop") + "data: [DONE]\n\n" })
    );
    const first = t.call("A", "w1");
    let seen = "";
    const second = t.call("B", "w2", (text) => (seen = text));
    await until(() => (seen.match(/: keep-alive/g) ?? []).length >= 2);
    // no Anthropic ping event ever reaches an OpenAI-format stream
    expect(seen).not.toContain("event: ping");
    expect(seen).not.toContain('{"type":"ping"}');
    // what has arrived so far is exactly the keepalives, as SSE comments
    expect(seen).toMatch(/^(: keep-alive\n\n)+$/);
    t.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.text.match(/: keep-alive/g)!.length).toBeGreaterThanOrEqual(2);
    expect(b.text).not.toContain("event: ping");
    const msgs = parseSse(b.text);
    expect(msgs.filter((m) => m.event !== "ping").map((m) => (m.data === "[DONE]" ? m.data : JSON.parse(m.data!)))).toEqual([
      { id: "c1", object: "chat.completions.chunk", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] },
      "[DONE]",
    ]);
  });

  it("/v1/messages keeps the ping event byte-for-byte", async () => {
    process.env.PAI_ROUTER_PING_MS = "25";
    const t = await setup(
      "/v1/messages",
      (stream) => JSON.stringify({ model: "qwen-test", stream, messages: [{ role: "user", content: "hi" }] }),
      () => ({ ct: "text/event-stream", body: 'event: message_delta\ndata: {"type": "message_delta", "delta": {}, "usage": {"output_tokens": 3}}\n\n' })
    );
    const first = t.call("A", "w1");
    let seen = "";
    const second = t.call("B", "w2", (text) => (seen = text));
    await until(() => (seen.match(/event: ping/g) ?? []).length >= 2);
    expect(seen).not.toContain(": keep-alive");
    t.release();
    const [, b] = await Promise.all([first, second]);
    expect(b.status).toBe(200);
    expect(b.text.match(/event: ping\ndata: \{"type":"ping"\}\n\n/g)!.length).toBeGreaterThanOrEqual(2);
    expect(b.text).toContain("message_delta");
  });
});
