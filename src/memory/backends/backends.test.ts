import { describe, it, expect, vi } from "vitest";
import { createOllamaBackend, truncateToTokens, type Tokenizer } from "./ollama.js";
import { detectBackends, createBackend, BACKEND_IDS } from "./index.js";
import type { EmbeddingBackend } from "./types.js";

const unit = (n: number, dims = 768) => {
  const v = new Array(dims).fill(0);
  v[n % dims] = 1;
  return v;
};

/** fetch stand-in: /api/tags lists `models`; /api/embed returns unit vectors. */
function fakeFetch(opts: { models?: string[]; down?: boolean; dims?: number; scale?: number; calls?: string[][] }) {
  return (async (url: string, init?: { body?: string }) => {
    if (opts.down) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (String(url).endsWith("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models: (opts.models ?? []).map((name) => ({ name })) }) };
    }
    const input = JSON.parse(init!.body!).input as string[];
    opts.calls?.push(input);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: input.map((_, i) => unit(i, opts.dims).map((x) => x * (opts.scale ?? 1))),
      }),
    };
  }) as unknown as typeof fetch;
}

/** One token per whitespace-separated word, plus [CLS]/[SEP]. */
const wordTok: Tokenizer = {
  encode: (t) => [101, ...t.split(" ").filter(Boolean).map((_, i) => 1000 + i), 102],
  decode: (ids) => ids.map(() => "w").join(" "),
};

describe("backend contract", () => {
  it("every registered id builds a backend with the full contract", () => {
    const cfg = { embedding: { backend: "x", ollama: { baseUrl: "http://h:1" } }, embeddingModel: "m" };
    for (const id of BACKEND_IDS) {
      const b: EmbeddingBackend = createBackend(id, cfg);
      expect(b.id).toBe(id);
      expect(b.dims).toBe(768);
      expect(b.maxTokens).toBe(512);
      expect(typeof b.model).toBe("string");
      expect(typeof b.available).toBe("function");
      expect(typeof b.embed).toBe("function");
    }
    expect(() => createBackend("nope", cfg)).toThrow(/Unknown embedding backend/);
  });
});

describe("ollama backend", () => {
  it("batches by 64, preserves order and returns normalized 768-dim vectors", async () => {
    const calls: string[][] = [];
    const b = createOllamaBackend({ model: "m" }, { fetch: fakeFetch({ models: ["m"], calls }), tokenizer: async () => wordTok });
    const out = await b.embed(Array.from({ length: 130 }, (_, i) => `t${i}`));
    expect(out).toHaveLength(130);
    expect(calls.map((c) => c.length)).toEqual([64, 64, 2]);
    expect(out[0]).toHaveLength(768);
    expect(Math.hypot(...out[0])).toBeCloseTo(1, 5);
  });

  it("rejects wrong dims and non-normalized vectors", async () => {
    const t = async () => wordTok;
    await expect(createOllamaBackend({}, { fetch: fakeFetch({ dims: 384 }), tokenizer: t }).embed(["a"])).rejects.toThrow(/384-dim/);
    await expect(createOllamaBackend({}, { fetch: fakeFetch({ scale: 2 }), tokenizer: t }).embed(["a"])).rejects.toThrow(/non-normalized/);
  });

  it("a down server throws a transient-coded error", async () => {
    const b = createOllamaBackend({}, { fetch: fakeFetch({ down: true }), tokenizer: async () => wordTok });
    await expect(b.embed(["a"])).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect((await b.available()).ok).toBe(false);
  });

  it("available() reports server down / model missing / ready", async () => {
    expect((await createOllamaBackend({ model: "m" }, { fetch: fakeFetch({ down: true }) }).available()).reason).toMatch(/no Ollama server/);
    expect((await createOllamaBackend({ model: "m" }, { fetch: fakeFetch({ models: ["other"] }) }).available()).reason).toMatch(/not present/);
    expect(await createOllamaBackend({ model: "m" }, { fetch: fakeFetch({ models: ["m:latest"] }) }).available()).toMatchObject({ ok: true });
  });
});

describe("510-token truncation", () => {
  const long = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");

  it("cuts to 510 content tokens, leaves short texts alone", () => {
    const r = truncateToTokens(long, wordTok);
    expect(r.truncated).toBe(true);
    expect(wordTok.encode(r.text).length).toBeLessThanOrEqual(512);
    expect(truncateToTokens("short text", wordTok)).toEqual({ text: "short text", truncated: false });
    const fits = Array.from({ length: 510 }, () => "w").join(" ");
    expect(truncateToTokens(fits, wordTok).truncated).toBe(false);
  });

  it("embed sends only capped texts and logs the count", async () => {
    const sent: string[][] = [];
    const log = vi.fn();
    const b = createOllamaBackend({}, {
      fetch: (async (_url: string, init?: { body?: string }) => {
        const input = JSON.parse(init!.body!).input as string[];
        sent.push(input);
        return { ok: true, status: 200, json: async () => ({ embeddings: input.map((_, i) => unit(i)) }) };
      }) as unknown as typeof fetch,
      tokenizer: async () => wordTok,
      log,
    });
    await b.embed([long, "short", long]);
    expect(sent[0].every((t) => wordTok.encode(t).length <= 512)).toBe(true);
    expect(sent[0][1]).toBe("short");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("truncated 2/3"));
  });
});

describe("discovery", () => {
  const cfg = { embedding: { backend: "transformers-cpu-q8", model: "m", ollama: { baseUrl: "http://h:1" } }, embeddingModel: "hf/m" };

  it("probes ollama first and recommends it when ready", async () => {
    const { results, recommended } = await detectBackends(cfg, { fetch: fakeFetch({ models: ["m"] }) });
    expect(results.map((r) => r.id)).toEqual(["ollama-f16", "transformers-cpu-q8"]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(recommended).toBe("ollama-f16");
  });

  it("reachable server without the model is provisionable; transformers is recommended", async () => {
    const { results, recommended } = await detectBackends(cfg, { fetch: fakeFetch({ models: [] }) });
    expect(results[0]).toMatchObject({ ok: false, provisionable: true });
    expect(results[0].reason).toMatch(/backend provision ollama/);
    expect(recommended).toBe("transformers-cpu-q8");
  });

  it("distinguishes installed-but-stopped from not installed", async () => {
    const down = fakeFetch({ down: true });
    const a = await detectBackends(cfg, { fetch: down, ollamaBinary: () => "/x/ollama" });
    expect(a.results[0].reason).toMatch(/ollama serve/);
    const b = await detectBackends(cfg, { fetch: down, ollamaBinary: () => null });
    expect(b.results[0].reason).toMatch(/not installed/);
    expect(b.recommended).toBe("transformers-cpu-q8");
  });
});
