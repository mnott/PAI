import { describe, it, expect, vi } from "vitest";
import type { UsageRow } from "./usage.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig } from "../workers/config.js";
import http from "node:http";
import { claudeUpstream, routerPort } from "./router.js";
import { endpointRegistry, type LocalInstance } from "../workers/local-instances.js";
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

  it("bare Claude aliases come from router.claudeModelAliases", () => {
    expect(resolveModel("opusplan", providers, "http://c/w/claude")).toMatchObject({ kind: "claude" });
    expect(resolveModel("opusplan-not", providers, "http://c/w/claude")).toMatchObject({ kind: "unknown" });
  });

  it("takes the claude upstream and port from config, default api.anthropic.com / 8790", () => {
    const saved = process.env.PAI_CONFIG_FILE;
    const cfgDir = mkdtempSync(join(tmpdir(), "router-cfg-"));
    try {
      process.env.PAI_CONFIG_FILE = join(cfgDir, "none.json");
      expect(claudeUpstream()).toBe("https://api.anthropic.com");
      expect(routerPort()).toBe(8790);
      expect(resolveModel("claude-haiku-4-5", providers, claudeUpstream())).toMatchObject({ kind: "claude", base: "https://api.anthropic.com" });
      writeFileSync(join(cfgDir, "config.yaml"), "router:\n  claudeUpstream: http://up.example/anthropic\n  port: 8899\n");
      process.env.PAI_CONFIG_FILE = join(cfgDir, "config.json");
      expect(claudeUpstream()).toBe("http://up.example/anthropic");
      expect(routerPort()).toBe(8899);
      const r = prepare("/v1/messages", hdr, body({ model: "claude-haiku-4-5", messages: [] }), providers);
      expect(r.ok && r.target).toMatchObject({ kind: "claude", base: "http://up.example/anthropic" });
    } finally {
      if (saved === undefined) delete process.env.PAI_CONFIG_FILE;
      else process.env.PAI_CONFIG_FILE = saved;
    }
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

describe("router host/origin perimeter", () => {
  const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
  const post = (port: number, headers: http.OutgoingHttpHeaders) =>
    new Promise<{ status: number; body: string }>((resolve) => {
      const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: b }));
      });
      q.end(JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [] }));
    });

  it("POST with Host evil.example is 403; the same POST with Host 127.0.0.1:<port> passes", async () => {
    const up = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const upPort = await listen(up);
    const r = createRouter(() => ({}), `http://127.0.0.1:${upPort}`, () => {}, undefined, undefined, {
      hosts: { bind: "loopback", extraHosts: [] },
    });
    const port = await listen(r);
    try {
      const evil = await post(port, { host: "evil.example:8790", "content-type": "application/json" });
      expect(evil.status).toBe(403);
      expect(JSON.parse(evil.body)).toEqual({ error: "host not allowed" });

      // the Claude Code proxy path: Host 127.0.0.1:<port>, no Origin — passes
      const ok = await post(port, { host: `127.0.0.1:${port}`, "content-type": "application/json" });
      expect(ok.status).toBe(200);

      // a browser cross-site POST: Host is loopback but the Origin is the attacker's page
      const xss = await post(port, { host: `127.0.0.1:${port}`, origin: "http://evil.example:8790", "content-type": "application/json" });
      expect(xss.status).toBe(403);
      expect(JSON.parse(xss.body)).toEqual({ error: "origin not allowed" });
    } finally {
      r.close();
      up.close();
    }
  });

  it("loopback perimeter: cockpit GET with Host evil.example is 403, with Host 127.0.0.1:<port> passes; a proxy POST with no Origin passes", async () => {
    const r = createRouter(() => ({}), "http://127.0.0.1:1", () => {}, undefined, undefined, {
      hosts: { bind: "loopback", extraHosts: [] },
    });
    const port = await listen(r);
    const get = (path: string, headers: http.OutgoingHttpHeaders) =>
      new Promise<number>((resolve) => {
        const q = http.request({ port, host: "127.0.0.1", path, headers }, (x) => {
          x.resume();
          x.on("end", () => resolve(x.statusCode ?? 0));
        });
        q.end();
      });
    try {
      // a rebinding browser GETs the cockpit page with the attacker's Host
      expect(await get("/cockpit", { host: "evil.example:8790" })).toBe(403);
      expect(await get("/cockpit", { host: `127.0.0.1:${port}` })).not.toBe(403);
      // proxy traffic: POST /v1/messages, Host localhost:<port>, no Origin
      const q = await new Promise<number>((resolve) => {
        const req = http.request(
          { port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { host: `localhost:${port}`, "content-type": "application/json" } },
          (x) => {
            x.resume();
            x.on("end", () => resolve(x.statusCode ?? 0));
          }
        );
        req.end(JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [] }));
      });
      expect(q).not.toBe(403);
    } finally {
      r.close();
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

describe("router 502 names the dead hop", () => {
  const post = (port: number, payload: object) =>
    new Promise<{ status: number; body: string }>((resolve) => {
      const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: b }));
      });
      q.end(JSON.stringify(payload));
    });

  it("claude upstream refused -> 502 body names the URL and router.claudeUpstream", async () => {
    const r = createRouter(() => ({}), "http://127.0.0.1:1", () => {});
    await new Promise<void>((ok) => r.listen(0, "127.0.0.1", ok));
    try {
      const res = await post((r.address() as { port: number }).port, { model: "claude-haiku-4-5", max_tokens: 1, messages: [] });
      expect(res.status).toBe(502);
      const msg = JSON.parse(res.body).error.message as string;
      expect(msg).toContain("ECONNREFUSED");
      expect(msg).toContain("http://127.0.0.1:1");
      expect(msg).toContain("router.claudeUpstream");
    } finally {
      r.close();
    }
  });

  it("local provider upstream refused -> 503 (model down) body names the URL and the provider", async () => {
    const prov = parseWorkersConfig({ providers: { dead: { baseUrl: "http://127.0.0.1:1/x", models: { default: "dead-model-1" } } } }).providers;
    const r = createRouter(() => prov, "http://127.0.0.1:1", () => {});
    await new Promise<void>((ok) => r.listen(0, "127.0.0.1", ok));
    try {
      const res = await post((r.address() as { port: number }).port, { model: "dead-model-1", max_tokens: 1, messages: [] });
      const msg = JSON.parse(res.body).error.message as string;
      expect(res.status).toBe(503);
      expect(msg).toContain("http://127.0.0.1:1");
      expect(msg).toContain("provider dead in workers.yaml");
    } finally {
      r.close();
    }
  });
});

describe("router: tier-launched local providers", () => {
  it("routes a disabled loopback provider a tier launches; others stay unrouted", async () => {
    const { withTierProviders } = await import("../workers/local-provider.js");
    const tiered = withTierProviders(providers, ["off"]);
    expect(routingTable(tiered).get("devstral-small-2")).toBe("off");
    expect(resolveModel("devstral-small-2", tiered)).toMatchObject({ kind: "provider", name: "off" });
    const none = withTierProviders(providers, []);
    expect(routingTable(none).has("devstral-small-2")).toBe(false);
    expect(resolveModel("devstral-small-2", none)).toMatchObject({ kind: "unknown" });
  });
});

describe("router: spread over local instances", () => {
  const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
  const post = (port: number) =>
    new Promise<number>((resolve) => {
      const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "x-pai-provider": "gyro" } }, (x) => {
        x.resume();
        x.on("end", () => resolve(x.statusCode ?? 0));
      });
      q.end(JSON.stringify({ model: "gyro-m", messages: [{ role: "user", content: "hi" }] }));
    });
  const inst = (n: number, port: number): LocalInstance => ({
    id: `gyro-m#${n}`, model: "gyro-m", provider: "gyro", url: `http://127.0.0.1:${port}`, origin: "managed",
    port, pid: process.pid, state: "ready", startedAt: 0, log: "",
  });

  it("2 instances take N concurrent requests; a dead one is skipped; none -> 503", async () => {
    const hits: Record<string, number> = { a: 0, b: 0 };
    const mk = (k: string) =>
      http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          hits[k]++;
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
          }, 20);
        });
      });
    const a = mk("a");
    const b = mk("b");
    const pa = await listen(a);
    const pb = await listen(b);
    // the provider's own url is a dead port: only instance expansion can reach a server
    const prov = parseWorkersConfig({ providers: { gyro: { baseUrl: "http://127.0.0.1:1", models: { default: "gyro-m" } } } }).providers;
    let running: LocalInstance[] = [inst(1, pa), inst(2, pb)];
    const rows: UsageRow[] = [];
    const r = createRouter(() => prov, "http://127.0.0.1:1", () => {}, (row) => rows.push(row), undefined, { instances: () => running });
    const port = await listen(r);
    try {
      const codes = await Promise.all(Array.from({ length: 6 }, () => post(port)));
      expect(codes).toEqual([200, 200, 200, 200, 200, 200]);
      expect(hits.a).toBeGreaterThan(0);
      expect(hits.b).toBeGreaterThan(0);
      expect(hits.a + hits.b).toBe(6);
      await vi.waitFor(() => expect(rows).toHaveLength(6));
      expect(new Set(rows.map((x) => x.provider))).toEqual(new Set(["gyro"]));
      expect(new Set(rows.map((x) => x.instance))).toEqual(new Set(["#1", "#2"]));
      running = [inst(2, pb)];
      const before = { ...hits };
      await Promise.all(Array.from({ length: 3 }, () => post(port)));
      expect(hits.a).toBe(before.a);
      expect(hits.b).toBe(before.b + 3);
      running = [];
      expect(await post(port)).toBe(503);
    } finally {
      r.close();
      a.close();
      b.close();
    }
  });
});

describe("router: managed and registered endpoints", () => {
  const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
  const post = (port: number, provider: string, model: string) =>
    new Promise<number>((resolve) => {
      const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "x-pai-provider": provider } }, (x) => {
        x.resume();
        x.on("end", () => resolve(x.statusCode ?? 0));
      });
      q.end(JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }));
    });
  const serve = () =>
    http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });

  it("a managed and a registered endpoint are both resolved; rows carry the host; unhealthy ones are skipped", async () => {
    const a = serve();
    const b = serve();
    const pa = await listen(a);
    const pb = await listen(b);
    const prov = parseWorkersConfig({
      providers: {
        gyro: { baseUrl: "http://127.0.0.1:1", models: { default: "gyro-m" } },
        box: { baseUrl: `http://127.0.0.1:${pb}`, models: { default: "box-m" }, characteristics: { tags: ["big"] } },
      },
    }).providers;
    const managed: LocalInstance = {
      id: "gyro-m#1", model: "gyro-m", provider: "gyro", url: `http://127.0.0.1:${pa}`, origin: "managed",
      port: pa, pid: process.pid, state: "ready", startedAt: 0, log: "",
    };
    let up = true;
    const rows: UsageRow[] = [];
    const r = createRouter(() => prov, "http://127.0.0.1:1", () => {}, (row) => rows.push(row), undefined, {
      instances: () => [managed],
      healthy: (i) => i.origin === "managed" || up,
    });
    const port = await listen(r);
    try {
      expect(await post(port, "gyro", "gyro-m")).toBe(200);
      expect(await post(port, "box", "box-m")).toBe(200);
      await vi.waitFor(() => expect(rows).toHaveLength(2));
      const byProv = Object.fromEntries(rows.map((x) => [x.provider, x]));
      expect(byProv.gyro.host).toBe(`127.0.0.1:${pa}`);
      expect(byProv.gyro.instance).toBe("#1");
      expect(byProv.box.host).toBe(`127.0.0.1:${pb}`);
      expect(byProv.box.instance).toBeUndefined();
      up = false;
      expect(await post(port, "box", "box-m")).toBe(200);
      await vi.waitFor(() => expect(rows).toHaveLength(3));
      expect(rows[2].host).toBeUndefined();
    } finally {
      r.close();
      a.close();
      b.close();
    }
  });

  it("a registered endpoint is probed once per interval with the router and a second reader on the same instance", async () => {
    const { createEndpointHealth } = await import("../workers/endpoint-health.js");
    const a = serve();
    const pa = await listen(a);
    const prov = parseWorkersConfig({
      providers: { box: { baseUrl: `http://127.0.0.1:${pa}`, models: { default: "box-m" }, characteristics: { tags: ["big"] } } },
    }).providers;
    const probes: string[] = [];
    let t = 1000;
    const health = createEndpointHealth({ probe: async (u) => { probes.push(u); return true; }, intervalMs: 15_000, now: () => t });
    const r = createRouter(() => prov, "http://127.0.0.1:1", () => {}, () => {}, undefined, { instances: () => [], health });
    const port = await listen(r);
    try {
      expect(await post(port, "box", "box-m")).toBe(200);
      expect(await post(port, "box", "box-m")).toBe(200);
      // the cockpit reads the same instance: its refresh inside the interval probes nothing
      const reg = endpointRegistry([], prov, { tiers: {} } as never);
      await health.refresh(reg);
      expect(probes).toHaveLength(1);
      t += 20_000;
      await health.refresh(reg);
      expect(probes).toHaveLength(2);
    } finally {
      r.close();
      a.close();
    }
  });
});

describe("router: malformed local tool call", () => {
  const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
  const DAMAGED = "<tool_call>\n<=Bash>\n<parameter=command>\nls\n</parameter>\n</function>";
  const msg = (content: object[], stop: string) => JSON.stringify({ type: "message", role: "assistant", content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });
  const GOOD = msg([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], "tool_use");
  const BAD = msg([{ type: "text", text: DAMAGED }], "end_turn");
  const run = async (answers: string[], retry = true, userText = "hi", messages?: object[]) => {
    const seen: string[] = [];
    const up = http.createServer((req, res) => {
      const bits: Buffer[] = [];
      req.on("data", (c) => bits.push(c));
      req.on("end", () => {
        seen.push(Buffer.concat(bits).toString());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(answers[Math.min(seen.length, answers.length) - 1]);
      });
    });
    const upPort = await listen(up);
    const prov = parseWorkersConfig({ providers: { gyro: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "gyro-m" } } } }).providers;
    const logs: string[] = [];
    const r = createRouter(() => prov, "http://127.0.0.1:1", (l) => logs.push(l), undefined, undefined, { instances: () => [], localToolCallRetry: retry });
    const port = await listen(r);
    const out = await new Promise<string>((resolve) => {
      const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "x-pai-provider": "gyro" } }, (x) => {
        const bits: Buffer[] = [];
        x.on("data", (c) => bits.push(c));
        x.on("end", () => resolve(Buffer.concat(bits).toString()));
      });
      q.end(JSON.stringify({ model: "gyro-m", messages: messages ?? [{ role: "user", content: userText }] }));
    });
    r.close();
    up.close();
    return { out, seen, logs };
  };

  it("damaged then good: the client sees the good tool_use", async () => {
    const { out, seen, logs } = await run([BAD, GOOD]);
    expect(JSON.parse(out).content[0].type).toBe("tool_use");
    expect(seen).toHaveLength(2);
    const msgs = JSON.parse(seen[1]).messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[2]).toMatchObject({ role: "user" });
    expect(msgs[2].content).toMatch(/damaged format/);
    expect(logs.some((l) => l.includes("malformed-tool-call retried provider=gyro ok"))).toBe(true);
  });

  it("truncated call with no <parameter= or </function>: retried once", async () => {
    const TRUNC = "<tool_call>\n<\n</";
    const { out, seen, logs } = await run([msg([{ type: "text", text: TRUNC }], "end_turn"), GOOD]);
    expect(JSON.parse(out).content[0].type).toBe("tool_use");
    expect(seen).toHaveLength(2);
    expect(logs.some((l) => l.includes("malformed-tool-call retried provider=gyro ok"))).toBe(true);
  });

  it("prose that merely mentions tool_call in backticks: delivered, no retry", async () => {
    const PROSE = "Ship it — the `tool_call` block was fine, then done.";
    const { out, seen } = await run([msg([{ type: "text", text: PROSE }], "end_turn"), GOOD]);
    expect(JSON.parse(out).content[0].text).toBe(PROSE);
    expect(seen).toHaveLength(1);
  });

  it("damaged twice: passed through unchanged after one retry", async () => {
    const { out, seen, logs } = await run([BAD, BAD]);
    expect(JSON.parse(out).content[0].text).toBe(DAMAGED);
    expect(seen).toHaveLength(2);
    expect(logs.some((l) => l.includes("malformed-tool-call retried provider=gyro again"))).toBe(true);
  });

  it("degenerate answer on a long task: retried once with the nudge", async () => {
    const COMMA = msg([{ type: "text", text: "," }], "end_turn");
    const { out, seen, logs } = await run([COMMA, GOOD], true, "x".repeat(300));
    expect(JSON.parse(out).content[0].type).toBe("tool_use");
    expect(seen).toHaveLength(2);
    const msgs = JSON.parse(seen[1]).messages;
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "," });
    expect(msgs[2].content).toMatch(/empty of content/);
    expect(logs.some((l) => l.includes("degenerate-answer retried provider=gyro ok"))).toBe(true);
  });

  it("empty final answer after 20 completed tool calls: a normal end, no retry", async () => {
    const EMPTY = msg([{ type: "text", text: "" }], "end_turn");
    const messages: object[] = [{ role: "user", content: "x".repeat(300) }];
    for (let i = 1; i <= 20; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `w${i}`, name: "Write", input: { file_path: `out/${i}.txt`, content: "a" } }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `w${i}`, content: "ok" }] });
    }
    const { out, seen, logs } = await run([EMPTY, GOOD], true, "", messages);
    expect(JSON.parse(out).content[0].text).toBe("");
    expect(seen).toHaveLength(1);
    expect(logs.some((l) => l.includes("retry"))).toBe(false);
  });

  it("genuinely empty first answer: one retry (logged with tool count); a second empty is delivered", async () => {
    const EMPTY = msg([{ type: "text", text: "" }], "end_turn");
    const { out, seen, logs } = await run([EMPTY, EMPTY, GOOD], true, "x".repeat(300));
    expect(JSON.parse(out).content[0].text).toBe("");
    expect(seen).toHaveLength(2);
    expect(logs.some((l) => l.includes("degenerate-answer retry provider=gyro reason=empty-answer-no-tool-work tools=0"))).toBe(true);
  });

  it("short answer to a short task: delivered, no retry", async () => {
    const COMMA = msg([{ type: "text", text: "," }], "end_turn");
    const { out, seen } = await run([COMMA, GOOD]);
    expect(JSON.parse(out).content[0].text).toBe(",");
    expect(seen).toHaveLength(1);
  });

  it("switch off: no retry", async () => {
    const { out, seen } = await run([BAD, GOOD], false);
    expect(JSON.parse(out).content[0].text).toBe(DAMAGED);
    expect(seen).toHaveLength(1);
  });
});

describe("router: degenerate retry is once per turn", () => {
  it("the same turn arriving again is not retried a second time", async () => {
    const EMPTY = JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    let n = 0;
    const up = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        n++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(EMPTY);
      });
    });
    const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
    const upPort = await listen(up);
    const prov = parseWorkersConfig({ providers: { gyro: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "gyro-m" } } } }).providers;
    const logs: string[] = [];
    const r = createRouter(() => prov, "http://127.0.0.1:1", (l) => logs.push(l), undefined, undefined, { instances: () => [], localToolCallRetry: true });
    const port = await listen(r);
    const post = () =>
      new Promise<void>((resolve) => {
        const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "x-pai-provider": "gyro" } }, (x) => {
          x.resume();
          x.on("end", () => resolve());
        });
        q.end(JSON.stringify({ model: "gyro-m", messages: [{ role: "user", content: "y".repeat(300) }] }));
      });
    await post();
    expect(n).toBe(2);
    await post();
    expect(n).toBe(3);
    expect(logs.some((l) => l.includes("retry-skipped") && l.includes("already-retried"))).toBe(true);
    r.close();
    up.close();
  });
});
