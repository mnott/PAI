import { describe, it, expect, vi } from "vitest";
import { createOllamaBackend, type Tokenizer } from "./ollama.js";
import { brokenRunnerReason, EMBED_HEAL_MIN_GAP_MS, type SelfHeal } from "./ollama-self-heal.js";

const tok: Tokenizer = { encode: (t) => [101, ...t.split(" ").map((_, i) => i), 102], decode: () => "w" };
const unit = (n: number) => Object.assign(new Array(768).fill(0), { [n]: 1 });

const METAL = '{"error":"llama-server process has terminated: exit status 1: error: failed to initialize the Metal library"}';

/** /api/embed answers each queued reply in turn: a status+body, or ok vectors. */
function embedFetch(replies: Array<{ status: number; body?: string }>) {
  let n = 0;
  const fn = vi.fn(async (_url: string, init?: { body?: string }) => {
    const r = replies[Math.min(n++, replies.length - 1)];
    if (r.status !== 200) return { ok: false, status: r.status, text: async () => r.body ?? "" };
    const input = JSON.parse(init!.body!).input as string[];
    return { ok: true, status: 200, json: async () => ({ embeddings: input.map((_, i) => unit(i)) }) };
  });
  return fn;
}

function fakeHeal(o: { last?: number; restartOk?: boolean } = {}) {
  let last = o.last ?? 0;
  const restart = vi.fn(async () => ({ ok: o.restartOk ?? true, message: o.restartOk === false ? "ollama not ready after 120 s\nsee log" : "ollama up" }));
  const heal: SelfHeal = { restart, now: () => 1_000_000_000, lastRestart: () => last, stamp: (at) => void (last = at) };
  return { heal, restart };
}

const build = (fetchFn: ReturnType<typeof embedFetch>, heal: SelfHeal, log = vi.fn()) =>
  createOllamaBackend({}, { fetch: fetchFn as unknown as typeof fetch, tokenizer: async () => tok, heal, log });

describe("brokenRunnerReason", () => {
  it("matches only 500s that name a dead runner or GPU init failure", () => {
    expect(brokenRunnerReason(500, METAL)).toBe("process has terminated");
    expect(brokenRunnerReason(500, "failed to initialize MTL device")).toBe("failed to initialize MTL");
    expect(brokenRunnerReason(500, "failed to allocate context")).toBe("failed to allocate context");
    expect(brokenRunnerReason(500, "model not found")).toBeNull();
    expect(brokenRunnerReason(503, METAL)).toBeNull();
  });
});

describe("ollama embed self-heal", () => {
  it("Metal 500 -> one restart -> retry succeeds", async () => {
    const f = embedFetch([{ status: 500, body: METAL }, { status: 200 }]);
    const { heal, restart } = fakeHeal();
    const log = vi.fn();
    const out = await build(f, heal, log).embed(["a"]);
    expect(out).toHaveLength(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith("ollama", "process has terminated");
    expect(f).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("EMBED-SELF-HEAL runtime=ollama reason=process has terminated");
  });

  it("second failure -> clear error, and no second restart within 10 minutes", async () => {
    const f = embedFetch([{ status: 500, body: METAL }]);
    const { heal, restart } = fakeHeal();
    const b = build(f, heal);
    await expect(b.embed(["a"])).rejects.toThrow(/^Ollama embed failed after a runtime restart: Ollama \/api\/embed HTTP 500/);
    expect(restart).toHaveBeenCalledTimes(1);
    await expect(b.embed(["a"])).rejects.toThrow(/after a runtime restart/);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("restarts again once the 10 minute gap has passed", async () => {
    const f = embedFetch([{ status: 500, body: METAL }, { status: 200 }]);
    const { heal, restart } = fakeHeal({ last: 1_000_000_000 - EMBED_HEAL_MIN_GAP_MS - 1 });
    await build(f, heal).embed(["a"]);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("a restart that does not come back is reported with its first line", async () => {
    const f = embedFetch([{ status: 500, body: METAL }]);
    const { heal } = fakeHeal({ restartOk: false });
    await expect(build(f, heal).embed(["a"])).rejects.toThrow("Ollama embed failed after a runtime restart: ollama not ready after 120 s");
  });

  it("an unrelated 500 does not restart", async () => {
    const f = embedFetch([{ status: 500, body: '{"error":"model not found"}' }]);
    const { heal, restart } = fakeHeal();
    await expect(build(f, heal).embed(["a"])).rejects.toThrow(/^Ollama \/api\/embed HTTP 500/);
    expect(restart).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
