/**
 * Prompt reuse of a vllm-mlx server, read from the server log PAI owns
 * (`logs/local/<provider>[-n].log`): the engine exposes no counters over HTTP, but its scheduler
 * logs one line per request:
 *   INFO:vllm_mlx.scheduler:[cache_fetch] request=<id> HIT prompt_tokens=16050 cached=13641 remaining=2409 time=0.001s
 *   INFO:vllm_mlx.scheduler:[cache_fetch] request=<id> MISS prompt_tokens=...
 * Each log is tailed incrementally (byte offset), never re-read whole.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { readLocalConfig, logPathFor } from "../workers/local-tiers.js";
import { workersYamlPath } from "../workers/workers-config.js";
import type { PrefixCacheStats } from "./limits.js";

/** Largest read per poll; a log further behind is entered at its last chunk. */
export const LOG_READ_MAX_BYTES = 1024 * 1024;

const LINE = /\[cache_fetch\]\s+request=\S+\s+(HIT|MISS)\b(.*)$/;

export interface CacheLogTotals {
  hits: number;
  misses: number;
  promptTokens: number;
  cachedTokens: number;
}

/** One cache_fetch log line → its verdict, or null for any other line. */
export function parseCacheFetchLine(line: string): { hit: boolean; promptTokens: number; cached: number } | null {
  const m = LINE.exec(line.trimEnd());
  if (!m) return null;
  const field = (k: string): number => {
    const f = new RegExp(`\\b${k}=(\\d+)`).exec(m[2]);
    return f ? Number(f[1]) : 0;
  };
  const hit = m[1] === "HIT";
  return { hit, promptTokens: field("prompt_tokens"), cached: hit ? field("cached") : 0 };
}

/** Incremental reader of one log: totals since the tail began (or the log last restarted). */
export class CacheLogTail {
  private offset = -1;
  private partial = "";
  private totals: CacheLogTotals = { hits: 0, misses: 0, promptTokens: 0, cachedTokens: 0 };

  constructor(private readonly path: string, private readonly maxBytes = LOG_READ_MAX_BYTES) {}

  /** Read what the log gained since the last poll; null when it cannot be read. */
  poll(): CacheLogTotals | null {
    if (!existsSync(this.path)) return null;
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      if (this.offset < 0 || size < this.offset) {
        // first look, or the log was truncated / replaced by a restart: totals start over
        if (this.offset >= 0) this.totals = { hits: 0, misses: 0, promptTokens: 0, cachedTokens: 0 };
        this.offset = 0;
        this.partial = "";
      }
      let start = this.offset;
      if (size - start > this.maxBytes) {
        start = size - this.maxBytes;
        this.partial = "";
        if (start > 0) this.skipToLine = true;
      }
      const len = size - start;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, start);
        this.consume(buf.toString("utf8", 0, n));
        this.offset = start + n;
      }
      return { ...this.totals };
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  private skipToLine = false;

  private consume(text: string): void {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    if (this.skipToLine) {
      lines.shift(); // entered mid-line
      this.skipToLine = false;
    }
    for (const l of lines) {
      const r = parseCacheFetchLine(l);
      if (!r) continue;
      if (r.hit) this.totals.hits++;
      else this.totals.misses++;
      this.totals.promptTokens += r.promptTokens;
      this.totals.cachedTokens += r.cached;
    }
  }
}

/** Totals → the tile's counters; undefined while the log has shown no request. */
export function logCacheStats(t: CacheLogTotals | null): PrefixCacheStats | undefined {
  if (!t) return undefined;
  const n = t.hits + t.misses;
  if (!n) return undefined;
  return { hits: t.hits, misses: t.misses, hitRate: t.hits / n, tokensSaved: t.cachedTokens };
}

const tails = new Map<string, CacheLogTail>();

/** The log of the vllm-mlx instance serving `port` (tier base port + k → instance k+1), else of the provider's tier. */
export function logPathOfInstance(provider: string, port: number, yamlPath: string = workersYamlPath()): string | undefined {
  try {
    const tiers = Object.values(readLocalConfig(yamlPath).tiers).filter((t) => t.engine === "vllm-mlx");
    const byPort = tiers.find((t) => port >= t.port && port - t.port <= 50);
    if (byPort) return logPathFor(byPort.provider, port - byPort.port + 1);
    const byName = tiers.find((t) => t.provider === provider);
    return byName ? logPathFor(byName.provider, 1) : undefined;
  } catch {
    return undefined;
  }
}

/** Prompt-reuse counters of a vllm-mlx instance from its own log (one tail per log path). */
export function vllmLogCacheStats(provider: string, port: number): PrefixCacheStats | undefined {
  const path = logPathOfInstance(provider, port);
  if (!path) return undefined;
  let tail = tails.get(path);
  if (!tail) tails.set(path, (tail = new CacheLogTail(path)));
  return logCacheStats(tail.poll());
}
