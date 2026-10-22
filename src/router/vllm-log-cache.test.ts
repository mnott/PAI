import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheLogTail, logCacheStats, parseCacheFetchLine } from "./vllm-log-cache.js";

const HIT = "INFO:vllm_mlx.scheduler:[cache_fetch] request=4ac2c736-709 HIT prompt_tokens=16050 cached=13641 remaining=2409 time=0.001s\n";
const MISS = "INFO:vllm_mlx.scheduler:[cache_fetch] request=aa11 MISS prompt_tokens=1000 cached=0 remaining=1000 time=0.000s\n";
const NOISE = "INFO:vllm_mlx.server:Model loaded\n";

describe("parseCacheFetchLine", () => {
  it("reads HIT and MISS, ignores other lines", () => {
    expect(parseCacheFetchLine(HIT)).toEqual({ hit: true, promptTokens: 16050, cached: 13641 });
    expect(parseCacheFetchLine(MISS)).toEqual({ hit: false, promptTokens: 1000, cached: 0 });
    expect(parseCacheFetchLine(NOISE)).toBeNull();
  });
});

describe("CacheLogTail", () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cachelog-"));
    log = join(dir, "x.log");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("null while the log is absent, undefined stats while it shows no request", () => {
    const t = new CacheLogTail(log);
    expect(t.poll()).toBeNull();
    writeFileSync(log, NOISE);
    expect(logCacheStats(t.poll())).toBeUndefined();
  });

  it("accumulates incrementally and handles a line split across polls", () => {
    writeFileSync(log, NOISE + HIT + MISS.slice(0, 30));
    const t = new CacheLogTail(log);
    expect(t.poll()).toEqual({ hits: 1, misses: 0, promptTokens: 16050, cachedTokens: 13641 });
    appendFileSync(log, MISS.slice(30) + HIT);
    const s = logCacheStats(t.poll())!;
    expect(s).toMatchObject({ hits: 2, misses: 1, tokensSaved: 27282 });
    expect(s.hitRate).toBeCloseTo(2 / 3);
    expect(t.poll()).toMatchObject({ hits: 2, misses: 1 });
  });

  it("starts over when the log is truncated", () => {
    writeFileSync(log, HIT + HIT + MISS);
    const t = new CacheLogTail(log);
    expect(t.poll()).toMatchObject({ hits: 2, misses: 1 });
    truncateSync(log, 0);
    writeFileSync(log, MISS);
    expect(t.poll()).toEqual({ hits: 0, misses: 1, promptTokens: 1000, cachedTokens: 0 });
  });

  it("starts over when the log is replaced by a larger file", () => {
    writeFileSync(log, HIT);
    const t = new CacheLogTail(log);
    expect(t.poll()).toMatchObject({ hits: 1, misses: 0 });
    rmSync(log);
    writeFileSync(log, MISS.repeat(3) + NOISE.repeat(3));
    expect(t.poll()).toEqual({ hits: 0, misses: 3, promptTokens: 3000, cachedTokens: 0 });
  });

  it("reads only the last chunk of a log far behind, dropping the cut line", () => {
    writeFileSync(log, HIT.repeat(100));
    const t = new CacheLogTail(log, HIT.length * 10 + 5);
    expect(t.poll()!.hits).toBe(10);
  });
});
