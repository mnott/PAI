import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priceTable, priceTableText, renderUsage, sumRunUsage, sumUsage, transcriptUsage, usageJson, workerUsage } from "./usage.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pai-usage-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const asst = (id: string, model: string, usage: object) => JSON.stringify({ type: "assistant", message: { id, model, usage } });
const jl = (...l: string[]) => l.join("\n") + "\n";

function status(dir: string, id: string, provider: string, model: string, label: string, started: string) {
  writeFileSync(join(dir, `${id}.status`), JSON.stringify({ id, provider, model, label, started, state: "done" }));
}

describe("sumUsage", () => {
  it("counts a repeated message id once with its final usage and splits cache writes", () => {
    const text = jl(
      asst("m1", "claude-sonnet-5-5", { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } }),
      asst("m1", "claude-sonnet-5-5", { input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } }),
      asst("m2", "claude-sonnet-5-5", { input_tokens: 1, output_tokens: 7, cache_creation_input_tokens: 50 }),
      JSON.stringify({ type: "result", total_cost_usd: 0.25 })
    );
    const r = sumUsage(text);
    expect(r.costUsd).toBe(0.25);
    expect(r.byModel.get("claude-sonnet-5-5")).toEqual({ input: 3, cacheRead: 100, cacheWrite5m: 60, cacheWrite1h: 20, output: 47 });
  });
});

describe("workerUsage", () => {
  it("groups cloud and local workers, filters by label and time", () => {
    const dir = tmp();
    status(dir, "w1", "anthropic", "claude-sonnet-5-5", "armB one", "2026-10-18 06:00:00");
    writeFileSync(
      join(dir, "w1.jsonl"),
      jl(asst("a", "claude-sonnet-5-5", { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 8, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 5 } }), asst("a", "claude-sonnet-5-5", { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 8, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 5 } }), JSON.stringify({ type: "result", total_cost_usd: 0.5 }))
    );
    status(dir, "w2", "anthropic", "claude-sonnet-5-5", "armB two", "2026-10-18 06:30:00");
    writeFileSync(join(dir, "w2.jsonl"), jl(asst("b", "claude-sonnet-5-5", { input_tokens: 1, output_tokens: 1 }), JSON.stringify({ type: "result", total_cost_usd: 0.1 })));
    status(dir, "w3", "lmstudio", "qwen", "armA one", "2026-10-18 06:10:00");
    writeFileSync(join(dir, "w3.jsonl"), jl(asst("c", "qwen", { input_tokens: 100, output_tokens: 9, cache_read_input_tokens: 7 }), JSON.stringify({ type: "result", total_cost_usd: 0 })));
    const urls = { anthropic: "https://api.anthropic.com", lmstudio: "http://127.0.0.1:1234" };

    const all = workerUsage(dir, {}, urls);
    expect(all.rows.map((r) => [r.provider, r.local, r.workers])).toEqual([["anthropic", false, 2], ["lmstudio", true, 1]]);
    expect(all.cloud.tally).toEqual({ input: 11, cacheRead: 0, cacheWrite5m: 3, cacheWrite1h: 5, output: 5 });
    expect(all.cloud.costUsd).toBeCloseTo(0.6);
    expect(all.local.tally.input).toBe(100);
    expect(all.local.costUsd).toBeNull();
    const text = renderUsage(all, { workers: true });
    expect(text).toContain("CACHE WRITE 5m");
    expect(text).toContain("lmstudio (local)");
    expect(text).toContain("TOTAL local");
    expect((usageJson(all) as { rows: unknown[] }).rows).toHaveLength(2);

    const b = workerUsage(dir, { labelPrefix: "armB", since: new Date("2026-10-18T06:15:00") }, urls);
    expect(b.rows).toHaveLength(1);
    expect(b.cloud.workers).toBe(1);
    expect(b.cloud.tally.input).toBe(1);
  });
});

describe("sumRunUsage", () => {
  // the shape of a local run's log: every turn 0/0, the harness fills the totals into the result event
  const resultEvent = JSON.stringify({
    type: "result",
    total_cost_usd: 0.631925,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 25277 },
    modelUsage: {
      "qwen3-coder-30b-8bit": {
        inputTokens: 0,
        outputTokens: 25277,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        canonicalModel: "qwen3-coder-30b-8bit",
      },
    },
  });
  const zeroTurns = jl(
    asst("m1", "qwen3-coder-30b-8bit", { input_tokens: 0, output_tokens: 0 }),
    asst("m2", "qwen3-coder-30b-8bit", { input_tokens: 0, output_tokens: 0 })
  );

  it("(a) prefers the result event's totals over zero per-turn usage", () => {
    const r = sumRunUsage(zeroTurns + resultEvent + "\n", "qwen3-coder-30b-8bit");
    expect(r.byModel.get("qwen3-coder-30b-8bit")).toEqual({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 25277 });
    expect(r.costUsd).toBeCloseTo(0.631925);
  });

  it("(b) sums the per-turn usage when there is no result event (killed run)", () => {
    const r = sumRunUsage(
      jl(
        asst("m1", "qwen3-coder-30b-8bit", { input_tokens: 500, output_tokens: 40 }),
        asst("m1", "qwen3-coder-30b-8bit", { input_tokens: 500, output_tokens: 90 }),
        asst("m2", "qwen3-coder-30b-8bit", { input_tokens: 20, output_tokens: 10 })
      )
    );
    expect(r.byModel.get("qwen3-coder-30b-8bit")).toEqual({ input: 520, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 100 });
  });

  it("books result usage without modelUsage on the run's own model, but keeps per-turn sums when the result is empty too", () => {
    const bare = JSON.stringify({ type: "result", total_cost_usd: 1, usage: { input_tokens: 700, output_tokens: 200 } }) + "\n";
    expect(sumRunUsage(zeroTurns + bare, "local-model").byModel.get("local-model")).toMatchObject({ input: 700, output: 200 });
    const empty = JSON.stringify({ type: "result", total_cost_usd: 1, usage: { input_tokens: 0, output_tokens: 0 } }) + "\n";
    expect(sumRunUsage(zeroTurns + empty).byModel.get("qwen3-coder-30b-8bit")).toMatchObject({ input: 0, output: 0 });
  });

  it("keeps sumUsage (transcript semantics) at the per-turn sum", () => {
    expect(sumUsage(zeroTurns + resultEvent + "\n").byModel.get("qwen3-coder-30b-8bit")).toMatchObject({ input: 0, output: 0 });
  });
});

describe("workerUsage result events", () => {
  it("reports the local arm's output tokens from the result event", () => {
    const dir = tmp();
    status(dir, "l1", "local30x8", "qwen3-coder-30b-8bit", "ab-local one", "2026-10-18 09:00:00");
    writeFileSync(
      join(dir, "l1.jsonl"),
      jl(asst("m1", "qwen3-coder-30b-8bit", { input_tokens: 0, output_tokens: 0 }), JSON.stringify({ type: "result", total_cost_usd: 0.6, usage: { input_tokens: 0, output_tokens: 25277 }, modelUsage: { "qwen3-coder-30b-8bit": { inputTokens: 0, outputTokens: 25277, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }))
    );
    const rep = workerUsage(dir, { labelPrefix: "ab-local" }, { local30x8: "http://127.0.0.1:8034" });
    expect(rep.local.tally.output).toBe(25277);
    expect(rep.rows[0].model).toBe("qwen3-coder-30b-8bit");
    expect(renderUsage(rep, { workers: true })).toContain("25,277");
  });
});

describe("transcriptUsage", () => {
  it("sums two models and prices them from the table", () => {
    const dir = tmp();
    const f = join(dir, "t.jsonl");
    writeFileSync(
      f,
      jl(
        asst("x", "claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } }),
        asst("y", "claude-haiku-4-5-20251001", { input_tokens: 2_000_000, output_tokens: 0 })
      )
    );
    const r = transcriptUsage(f);
    expect(r.rows.map((x) => x.model)).toEqual(["claude-haiku-4-5-20251001", "claude-opus-5-5"]);
    // opus: 5 + 25 + 0.5 + 6.25 + 10 = 46.75 ; haiku: 2
    expect(r.rows[1].costUsd).toBeCloseTo(46.75);
    expect(r.rows[0].costUsd).toBeCloseTo(2);
    expect(r.cloud.costUsd).toBeCloseTo(48.75);
    expect(priceTableText()).toContain("sonnet");
  });
});

describe("sumRunUsage cache split", () => {
  const mu = (create: number, out: number) => ({ inputTokens: 1, outputTokens: out, cacheReadInputTokens: 5, cacheCreationInputTokens: create });
  const res = (usage: object, modelUsage: object) => JSON.stringify({ type: "result", usage, modelUsage }) + "\n";

  it("single model: totals from result.usage with the 1h split", () => {
    const r = sumRunUsage(res({ input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 900, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 } }, { "claude-sonnet-5-5": mu(100, 10) }));
    expect(r.byModel.get("claude-sonnet-5-5")).toEqual({ input: 2, cacheRead: 5, cacheWrite5m: 0, cacheWrite1h: 100, output: 900 });
  });

  it("several models: split proportionally with exact sums", () => {
    const r = sumRunUsage(res({ output_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 70, ephemeral_5m_input_tokens: 30 } }, { a: mu(33, 1), b: mu(33, 1), c: mu(34, 1) }));
    const ts = [...r.byModel.values()];
    expect(ts.reduce((n, t) => n + t.cacheWrite1h, 0)).toBe(70);
    expect(ts.reduce((n, t) => n + t.cacheWrite5m, 0)).toBe(30);
    for (const [k, c] of [["a", 33], ["b", 33], ["c", 34]] as const) {
      const t = r.byModel.get(k)!;
      expect(t.cacheWrite1h + t.cacheWrite5m).toBe(c);
    }
  });

  it("local result with output only is unchanged", () => {
    const r = sumRunUsage(res({ output_tokens: 50 }, { q: { inputTokens: 0, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }));
    expect(r.byModel.get("q")).toEqual({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 50 });
  });

  it("no result event: per-turn sum", () => {
    const r = sumRunUsage(jl(asst("m1", "x", { input_tokens: 1, output_tokens: 7 })));
    expect(r.byModel.get("x")?.output).toBe(7);
  });
});

describe("price table from workers.yaml", () => {
  it("ships opus, sonnet and haiku families", () => {
    expect(Object.keys(priceTable()).sort()).toEqual(["haiku", "opus", "sonnet"]);
    expect(priceTable().sonnet).toEqual({ input: 3, output: 15 });
  });
});
