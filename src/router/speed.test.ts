import { describe, expect, it } from "vitest";
import { buildSpeed, endpointSpeed, strataSpeed, percentile, outputRate, prefillRate, writeRate } from "./speed.js";
import { UsageSniffer, type UsageRow } from "./usage.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const row = (o: Partial<UsageRow>): UsageRow =>
  ({ ts: new Date(NOW - 60_000).toISOString(), model: "m", provider: "p", status: 200, ms: 1, bytes: 1, cache: "none", input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...o }) as UsageRow;

describe("speed", () => {
  it("computes read and write rates, skipping short or untimed rows", () => {
    expect(prefillRate([row({ input_tokens: 1000, ttftMs: 500 })])).toBe(2000);
    expect(prefillRate([row({ input_tokens: 1000 })])).toBeNull();
    expect(writeRate(row({ output_tokens: 100, decodeMs: 2000 }))).toBe(50);
    expect(writeRate(row({ output_tokens: 15, decodeMs: 2000 }))).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(10);
  });
  it("aggregates per provider+model over 1h and 24h; old rows without timing are ignored", () => {
    const rows = [
      row({ ttftMs: 100, input_tokens: 100, output_tokens: 50, decodeMs: 1000 }),
      row({ ttftMs: 300, input_tokens: 300, output_tokens: 50, decodeMs: 500 }),
      row({ ts: new Date(NOW - 5 * 3_600_000).toISOString(), ttftMs: 900, input_tokens: 90, output_tokens: 20, decodeMs: 1000 }),
      row({}),
      row({ status: 503, ttftMs: 5 }),
    ];
    const [s] = buildSpeed(rows, NOW, (m) => m, () => true);
    expect(buildSpeed(rows, NOW)).toHaveLength(1);
    expect(s!.h1.requests).toBe(2);
    expect(s!.h24.requests).toBe(3);
    expect(s!.h24.ttftP50).toBe(300);
    expect(s!.h1.writeTps).toBe(100);
  });
  it("prefill rate counts cache writes but not cache reads", () => {
    expect(prefillRate([row({ input_tokens: 2, cache_read_input_tokens: 497_951, cache_creation_input_tokens: 48, ttftMs: 5000 })], false)).toBe(10);
  });
  it("prefill rate excludes fully cached rows and rows with unknown cache counts", () => {
    expect(prefillRate([row({ input_tokens: 0, cache_read_input_tokens: 90_000, ttftMs: 500 })])).toBeNull();
    const unknown = row({ input_tokens: 1000, ttftMs: 500 });
    delete (unknown as Partial<UsageRow>).cache_read_input_tokens;
    expect(prefillRate([unknown])).toBeNull();
  });
  it("prefill rate is Σuncached / Σttft over mixed rows", () => {
    const rows = [
      row({ input_tokens: 100, cache_read_input_tokens: 50_000, ttftMs: 100 }),
      row({ input_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000, ttftMs: 300 }),
      row({ input_tokens: 0, cache_read_input_tokens: 90_000, ttftMs: 5000 }),
    ];
    expect(prefillRate(rows)).toBe(1250);
  });
  it("local prefill above the plausibility cap is dropped, cloud is not", () => {
    const fast = row({ input_tokens: 30_000, ttftMs: 1000 });
    expect(prefillRate([fast], true)).toBeNull();
    expect(prefillRate([fast], false)).toBe(30_000);
  });
  it("cloud output speed uses the whole reply time, local uses the decode window", () => {
    const burst = row({ output_tokens: 822, ttftMs: 11_447, decodeMs: 2, ms: 11_449 });
    expect(writeRate(burst, true)).toBe(411_000);
    expect(writeRate(burst, false)).toBeCloseTo(71.8, 1);
    expect(writeRate(row({ output_tokens: 100, decodeMs: 2000, ms: 9000 }))).toBe(50);
  });
  it("tags local from the provider predicate and applies it to the rates", () => {
    const rows = [row({ provider: "loc", ttftMs: 100, output_tokens: 100, decodeMs: 1000, ms: 4000 }), row({ provider: "cl", ttftMs: 100, output_tokens: 100, decodeMs: 1000, ms: 4000 })];
    const out = buildSpeed(rows, NOW, (m) => m, (p) => p === "loc");
    expect(out.find((r) => r.provider === "loc")).toMatchObject({ local: true, h24: { writeTps: 100 } });
    expect(out.find((r) => r.provider === "cl")).toMatchObject({ local: false, h24: { writeTps: 25 } });
  });
  it("output rate is the median of real-window rows, excluding ~0 ms and tiny rows, dropping implausible ones", () => {
    const burst = row({ ttftMs: 100, output_tokens: 138, decodeMs: 1, ms: 101 });
    const tiny = row({ ttftMs: 100, output_tokens: 4, decodeMs: 500, ms: 600 });
    const a = row({ ttftMs: 100, output_tokens: 100, decodeMs: 1000, ms: 1100 });
    const b = row({ ttftMs: 100, output_tokens: 300, decodeMs: 2000, ms: 2100 });
    expect(outputRate([burst, tiny])).toBeNull();
    expect(outputRate([burst, tiny, a, b])).toBe(150);
    const fast = row({ ttftMs: 100, output_tokens: 3000, decodeMs: 1000, ms: 1100 });
    expect(outputRate([fast, a])).toBe(100);
    expect(outputRate([fast], false)).toBeNull();
    expect(buildSpeed([burst, a, b], NOW, (m) => m, () => true)[0]!.h24.writeTps).toBe(150);
  });
  it("sniffer stamps the first content delta, not message_start", () => {
    const sn = new UsageSniffer("text/event-stream");
    sn.push(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'));
    expect(sn.firstContentAt).toBeUndefined();
    sn.push(Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n'));
    expect(sn.firstContentAt).toBeTypeOf("number");
  });
});

describe("endpointSpeed / strataSpeed", () => {
  const NOW = Date.parse("2026-10-24T20:00:00Z");
  const ts = new Date(NOW - 60_000).toISOString();
  const base = { ts, model: "m", provider: "coder-l", status: 200, bytes: 1, cache: "none" as const, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // the two operator rows: a buffered tool call (decodeMs ~0) and a short answer
  const rows = [
    { ...base, input_tokens: 6932, output_tokens: 57, ms: 28344, ttftMs: 28204, decodeMs: 2 },
    { ...base, input_tokens: 68, output_tokens: 54, ms: 3269, ttftMs: 3269, decodeMs: 0 },
  ] as unknown as UsageRow[];

  it("computes prefill from ttft and excludes buffered replies from decode", () => {
    const s = endpointSpeed(rows, "coder-l", NOW)!;
    expect(s.prefillN).toBe(2);
    expect(s.prefillTps).toBeCloseTo(7000 / 31.473, 0);
    expect(s.decodeN).toBe(0);
    expect(s.decodeTps).toBeNull();
    expect(s.text).toBe("prefill 222 t/s · decode – (n=2/0, 1h, measured)");
  });

  it("counts a streamed reply in decode", () => {
    const s = endpointSpeed([...rows, { ...base, input_tokens: 100, output_tokens: 200, ms: 6000, ttftMs: 1000, decodeMs: 5000 } as unknown as UsageRow], "coder-l", NOW)!;
    expect(s.decodeN).toBe(1);
    expect(s.decodeTps).toBe(40);
  });

  it("prefers server-reported timings", () => {
    const s = endpointSpeed([{ ...rows[0]!, promptMs: 20000, predictedMs: 1000 }], "coder-l", NOW)!;
    expect(s.prefillTps).toBe(346.6);
    expect(s.decodeTps).toBe(57);
    expect(s.source).toBe("server");
  });

  it("strataSpeed: decode from the totals delta, prefill from the live field", () => {
    const body = (out: number, ms: number) => JSON.stringify({ live: { state: "prefill", prefill_tok_s_mean: 572 }, totals: { output_tokens: out, decode_ms: ms } });
    expect(strataSpeed("k", body(100, 1000))!.decodeTps).toBeNull();
    const s = strataSpeed("k", body(500, 11000))!;
    expect(s.decodeTps).toBe(40);
    expect(s.prefillTps).toBe(572);
    expect(s.text).toBe("prefill 572 t/s · decode 40 t/s (server)");
  });
});

describe("UsageSniffer server timings", () => {
  it("reads llama-server prompt_ms/predicted_ms and Ollama durations", () => {
    const a = new UsageSniffer("application/json");
    a.push(Buffer.from(JSON.stringify({ usage: { input_tokens: 5 }, timings: { prompt_ms: 120, predicted_ms: 800 } })));
    a.finish();
    expect(a.serverTimings).toEqual({ promptMs: 120, predictedMs: 800 });
    const b = new UsageSniffer("application/json");
    b.push(Buffer.from(JSON.stringify({ usage: {}, timings: { prompt_eval_duration: 2e9, eval_duration: 4e9 } })));
    b.finish();
    expect(b.serverTimings).toEqual({ promptMs: 2000, predictedMs: 4000 });
  });
});
