import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig } from "../workers/config.js";
import http from "node:http";
import { createRouter, duplicateModelIds, estimateTokens, modelsReply, prepare, resolveModel, routingTable, stripContextSuffix, stripThinking } from "./router.js";

const dir = mkdtempSync(join(tmpdir(), "router-"));
writeFileSync(join(dir, "glm"), "glm-secret\n");
writeFileSync(join(dir, "kimi"), "kimi-secret\n");

const providers = parseWorkersConfig({
  providers: {
    glm: { baseUrl: "https://glm.example/api/anthropic", keyFile: join(dir, "glm"), models: { default: "glm-5.3[1m]", fast: "glm-5.3-flash" } },
    kimi: { baseUrl: "https://kimi.example/coding/", keyFile: join(dir, "kimi"), models: { default: "k3[1m]", fast: "kimi-for-coding[1m]" } },
    loc: { baseUrl: "http://127.0.0.1:8011", models: { default: "qwen3-coder-30b" } },
    off: { enabled: false, baseUrl: "http://127.0.0.1:8012", models: { default: "devstral-small-2" } },
  },
}).providers;

const body = (o: object) => Buffer.from(JSON.stringify(o));
const hdr = { authorization: "Bearer inbound", "x-api-key": "inbound", "anthropic-version": "2023-06-01" };

describe("router", () => {
  it("builds the routing table from providers, skipping disabled", () => {
    const t = routingTable(providers);
    expect(t.get("glm-5.3")).toBe("glm");
    expect(t.get("k3")).toBe("kimi");
    expect(t.get("qwen3-coder-30b")).toBe("loc");
    expect(t.has("devstral-small-2")).toBe(false);
  });

  it("strips a trailing [1m]", () => {
    expect(stripContextSuffix("glm-5.3[1m]")).toBe("glm-5.3");
    expect(stripContextSuffix("claude-opus-4-7")).toBe("claude-opus-4-7");
    const r = prepare("/v1/messages", hdr, body({ model: "k3[1m]", messages: [] }), providers);
    expect(r.ok && JSON.parse(r.up.body.toString()).model).toBe("k3");
  });

  it("routes claude ids to the claude base", () => {
    const r = resolveModel("claude-haiku-4-5-20251001", providers, "http://c/w/claude");
    expect(r).toMatchObject({ kind: "claude", base: "http://c/w/claude" });
  });

  it("defaults the claude base to first-party Anthropic", () => {
    const r = resolveModel("claude-haiku-4-5-20251001", providers);
    expect(r).toMatchObject({ kind: "claude", base: "https://api.anthropic.com" });
    const p = prepare("/v1/messages", hdr, body({ model: "claude-haiku-4-5-20251001", messages: [] }), providers);
    expect(p.ok && p.up.url.href).toBe("https://api.anthropic.com/v1/messages");
  });

  it("strips thinking only for non-anthropic targets", () => {
    const msgs = [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "redacted_thinking", data: "d" }, { type: "text", text: "hi" }] }];
    expect(stripThinking({ messages: msgs }).messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
    const g = prepare("/v1/messages", hdr, body({ model: "glm-5.3", messages: msgs }), providers);
    const c = prepare("/v1/messages", hdr, body({ model: "claude-haiku-4-5-20251001", messages: msgs }), providers);
    expect(g.ok && JSON.parse(g.up.body.toString()).messages[0].content).toHaveLength(1);
    expect(c.ok && JSON.parse(c.up.body.toString()).messages[0].content).toHaveLength(3);
  });

  it("drops the per-request billing header for providers so consecutive requests share their prefix", () => {
    const req = (cch: string, n: number) => ({
      model: "qwen3-coder-30b",
      tools: [{ name: "Read" }],
      system: [
        { type: "text", text: `x-anthropic-billing-header: cc_version=2.1; cch=${cch}; cc_turn_index=1;` },
        { type: "text", text: "You are Claude Code" },
      ],
      messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })),
    });
    const out = (b: object) => {
      const r = prepare("/v1/messages", hdr, body(b as never), providers);
      return r.ok ? r.up.body.toString() : "";
    };
    const a = out(req("3d35b", 1));
    const b = out(req("2b05b", 3));
    expect(a).not.toContain("billing-header");
    const stem = a.slice(0, a.indexOf('"messages"'));
    expect(b.startsWith(stem)).toBe(true);
    const c = prepare("/v1/messages", hdr, body({ ...req("1", 1), model: "claude-haiku-4-5-20251001" } as never), providers);
    expect(c.ok && c.up.body.toString()).toContain("billing-header");
  });

  it("folds the harness's trailing role:system messages so a local server sees an append-only history", () => {
    // shape captured from Claude Code 2.1.284: after each user turn a system
    // message (block array + cache_control while newest, plain string once old)
    const env = "# Environment\nplatform: darwin";
    const tok = (n: number) => `<total_tokens>${n} tokens left</total_tokens>`;
    const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] });
    const asst = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] };
    const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] };
    const sysArr = (t: string) => ({ role: "system", content: [{ type: "text", text: t, cache_control: { type: "ephemeral" } }] });
    const r1 = [user("task"), sysArr(env + "\n" + tok(100))];
    const r2 = [user("task"), { role: "system", content: env + "\n" + tok(100) }, asst, result, sysArr(tok(90))];
    const out = (messages: object[]) => {
      const r = prepare("/v1/messages", hdr, body({ model: "qwen3-coder-30b", messages }), providers);
      return r.ok ? (JSON.parse(r.up.body.toString()).messages as Array<{ role: string; content: Array<{ text?: string }> }>) : [];
    };
    const a = out(r1);
    const b = out(r2);
    expect(a.map((m) => m.role)).toEqual(["user"]);
    expect(b.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // request 2's first message is request 1's, byte for byte, apart from cache_control
    expect(JSON.stringify(b[0].content.map((c) => c.text))).toBe(JSON.stringify(a[0].content.map((c) => c.text)));
    expect(b[2].content.map((c) => c.text)).toEqual([undefined, tok(90)]);
    // a non-loopback provider keeps the messages untouched
    const g = prepare("/v1/messages", hdr, body({ model: "glm-5.3", messages: r2 }), providers);
    expect(g.ok && JSON.parse(g.up.body.toString()).messages).toHaveLength(5);
  });

  it("passes inbound auth to claude, injects the key for providers", () => {
    const c = prepare("/v1/messages", hdr, body({ model: "claude-haiku-4-5-20251001" }), providers);
    expect(c.ok && c.up.headers.authorization).toBe("Bearer inbound");
    expect(c.ok && c.up.headers["x-api-key"]).toBe("inbound");
    const g = prepare("/v1/messages/count_tokens", hdr, body({ model: "glm-5.3" }), providers);
    expect(g.ok && g.up.headers.authorization).toBe("Bearer glm-secret");
    expect(g.ok && g.up.headers["x-api-key"]).toBeUndefined();
    expect(g.ok && g.up.url.href).toBe("https://glm.example/api/anthropic/v1/messages/count_tokens");
    const k = prepare("/v1/messages", hdr, body({ model: "k3" }), providers);
    expect(k.ok && k.up.url.href).toBe("https://kimi.example/coding/v1/messages");
  });

  it("rejects unknown models with 400 listing routable ids", () => {
    const r = prepare("/v1/messages", hdr, body({ model: "gpt-9" }), providers);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.message).toContain("glm-5.3");
    }
  });

  it("answers model list and detail for routed ids, 404 for unknown", () => {
    const list = modelsReply("/v1/models", providers);
    expect(list?.status).toBe(200);
    expect((list?.body as { data: { id: string }[] }).data.map((d) => d.id)).toContain("glm-5.3");
    const one = modelsReply("/v1/models/glm-5.3", providers);
    expect(one?.body).toMatchObject({ id: "glm-5.3", type: "model", display_name: "glm-5.3" });
    expect(modelsReply("/v1/models/k3%5B1m%5D", providers)?.body).toMatchObject({ id: "k3" });
    expect(modelsReply("/v1/models/gpt-9", providers)?.status).toBe(404);
    expect(modelsReply("/v1/models/claude-opus-4-7", providers)).toBeNull();
    expect(modelsReply("/v1/other", providers)).toBeNull();
  });

  it("estimates tokens as chars/4", () => {
    expect(estimateTokens(Buffer.from("x".repeat(40)))).toBe(10);
  });
});

describe("router http", () => {
  const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
  const get = (port: number, path: string, method = "GET") =>
    new Promise<{ status: number; body: string }>((resolve) => {
      http.request({ port, host: "127.0.0.1", path, method }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: b }));
      }).end();
    });

  it("serves models locally, forwards claude detail, logs method+path on 404, estimates count_tokens", async () => {
    const seen: string[] = [];
    const up = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(req.url?.includes("/provider/") ? 404 : 200, { "content-type": "application/json" });
      res.end("{}");
    });
    const upPort = await listen(up);
    const prov = parseWorkersConfig({
      providers: { p: { baseUrl: `http://127.0.0.1:${upPort}/provider`, models: { default: "glm-5.3" } } },
    }).providers;
    const logs: string[] = [];
    const r = createRouter(() => prov, `http://127.0.0.1:${upPort}/w/claude`, (l) => logs.push(l));
    const port = await listen(r);
    try {
      expect((await get(port, "/v1/models/glm-5.3")).status).toBe(200);
      expect(seen).toEqual([]);
      expect((await get(port, "/v1/models/claude-opus-4-7")).status).toBe(200);
      expect(seen).toEqual(["GET /w/claude/v1/models/claude-opus-4-7"]);
      expect((await get(port, "/nope", "HEAD")).status).toBe(404);
      expect(logs.some((l) => l.includes("HEAD /nope") && l.includes("404"))).toBe(true);
      const ct = await new Promise<{ status: number; body: string }>((resolve) => {
        const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages/count_tokens", method: "POST" }, (x) => {
          let b = "";
          x.on("data", (c) => (b += c));
          x.on("end", () => resolve({ status: x.statusCode ?? 0, body: b }));
        });
        q.end(JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hello" }] }));
      });
      expect(ct.status).toBe(200);
      expect(JSON.parse(ct.body).input_tokens).toBeGreaterThan(0);
    } finally {
      r.close();
      up.close();
    }
  });
});

describe("duplicate model ids", () => {
  const dup = parseWorkersConfig({
    providers: {
      coder8: { baseUrl: "http://127.0.0.1:8018", models: { default: "qwen3-coder-30b-8bit" } },
      local30x8: { baseUrl: "http://127.0.0.1:8034", models: { default: "qwen3-coder-30b-8bit" } },
    },
  }).providers;
  const req = (headers: Record<string, string> = {}, hints = {}) =>
    prepare("/v1/messages", { ...hdr, ...headers }, body({ model: "qwen3-coder-30b-8bit", messages: [] }), dup, undefined, hints);
  const name = (r: ReturnType<typeof req>) => (r.ok && r.target.kind === "provider" ? r.target.name : "?");

  it("prefers the provider that is up", () => {
    const seen: string[] = [];
    const r = req({}, { isUp: (p: string) => p === "local30x8", onDuplicate: (m: string) => seen.push(m) });
    expect(name(r)).toBe("local30x8");
    expect(seen).toEqual(["qwen3-coder-30b-8bit"]);
  });
  it("keeps first-match when nothing is known", () => {
    expect(name(req())).toBe("coder8");
  });
  it("honours an explicit x-pai-provider route even when it is down", () => {
    expect(name(req({ "x-pai-provider": "coder8" }, { isUp: (p: string) => p === "local30x8" }))).toBe("coder8");
  });
  it("lists duplicates", () => {
    expect(duplicateModelIds(dup)).toEqual([{ model: "qwen3-coder-30b-8bit", providers: ["coder8", "local30x8"] }]);
    expect(duplicateModelIds(providers)).toEqual([]);
  });
  it("warns once per process through the handler", async () => {
    const lines: string[] = [];
    const dead = parseWorkersConfig({
      providers: {
        a: { baseUrl: "http://127.0.0.1:1", models: { default: "dup-model" } },
        b: { baseUrl: "http://127.0.0.1:2", models: { default: "dup-model" } },
      },
    }).providers;
    const server = createRouter(() => dead, "http://127.0.0.1:1", (l) => lines.push(l), undefined, undefined, { isUp: (p) => p === "b" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((resolve) => {
        const q = http.request({ port, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" } }, (res) => {
          res.resume();
          res.on("close", () => resolve());
        });
        q.end(JSON.stringify({ model: "dup-model", messages: [] }));
      });
    }
    server.close();
    expect(lines.filter((l) => l.includes("declared by several providers"))).toHaveLength(1);
  });
});

describe("router tool-name case correction", () => {
  it("rewrites a wrong-case tool_use in the SSE reply to the declared spelling and reports it", async () => {
    const sse =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"bash","input":{}}}\n\n';
    const up = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
    const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
    const upPort = await listen(up);
    const prov = parseWorkersConfig({
      providers: { p: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "glm-5.3" } } },
    }).providers;
    const fixes: string[] = [];
    const r = createRouter(() => prov, `http://127.0.0.1:${upPort}`, () => {}, undefined, undefined, {
      onToolCaseFix: (i) => fixes.push(`${i.from}->${i.to}`),
    });
    const port = await listen(r);
    try {
      const body = await new Promise<string>((resolve) => {
        const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST" }, (x) => {
          let b = "";
          x.on("data", (c) => (b += c));
          x.on("end", () => resolve(b));
        });
        q.end(JSON.stringify({ model: "glm-5.3", stream: true, tools: [{ name: "Bash" }], messages: [{ role: "user", content: "x" }] }));
      });
      expect(body).toContain('"name":"Bash"');
      expect(fixes).toEqual(["bash->Bash"]);
    } finally {
      r.close();
      up.close();
    }
  });
});
