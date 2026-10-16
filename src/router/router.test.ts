import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkersConfig } from "../workers/config.js";
import { prepare, resolveModel, routingTable, stripContextSuffix, stripThinking } from "./router.js";

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

  it("strips thinking only for non-anthropic targets", () => {
    const msgs = [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "redacted_thinking", data: "d" }, { type: "text", text: "hi" }] }];
    expect(stripThinking({ messages: msgs }).messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
    const g = prepare("/v1/messages", hdr, body({ model: "glm-5.3", messages: msgs }), providers);
    const c = prepare("/v1/messages", hdr, body({ model: "claude-haiku-4-5-20251001", messages: msgs }), providers);
    expect(g.ok && JSON.parse(g.up.body.toString()).messages[0].content).toHaveLength(1);
    expect(c.ok && JSON.parse(c.up.body.toString()).messages[0].content).toHaveLength(3);
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
});
