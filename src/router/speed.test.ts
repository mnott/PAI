import { describe, expect, it } from "vitest";
import { buildSpeed, percentile, readRate, writeRate } from "./speed.js";
import { UsageSniffer, type UsageRow } from "./usage.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const row = (o: Partial<UsageRow>): UsageRow =>
  ({ ts: new Date(NOW - 60_000).toISOString(), model: "m", provider: "p", status: 200, ms: 1, bytes: 1, cache: "none", input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...o }) as UsageRow;

describe("speed", () => {
  it("computes read and write rates, skipping short or untimed rows", () => {
    expect(readRate(row({ input_tokens: 1000, ttftMs: 500 }))).toBe(2000);
    expect(readRate(row({ input_tokens: 1000 }))).toBeNull();
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
    const [s] = buildSpeed(rows, NOW);
    expect(buildSpeed(rows, NOW)).toHaveLength(1);
    expect(s!.h1.requests).toBe(2);
    expect(s!.h24.requests).toBe(3);
    expect(s!.h24.ttftP50).toBe(300);
    expect(s!.h1.writeTps).toBe(100);
  });
  it("sniffer stamps the first content delta, not message_start", () => {
    const sn = new UsageSniffer("text/event-stream");
    sn.push(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'));
    expect(sn.firstContentAt).toBeUndefined();
    sn.push(Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n'));
    expect(sn.firstContentAt).toBeTypeOf("number");
  });
});
