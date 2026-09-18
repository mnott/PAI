/**
 * Tests for the cache-keepalive beat plumbing: transcript parsing, metrics
 * extraction, the cadence decision, and the daemon arming rules. Everything
 * runs against temp dirs — the live config is never read or written here.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEARTBEAT_PROMPT,
  beatBusy,
  beatId,
  extractBeatMetrics,
  keepaliveSecs,
  parseLastResultEvent,
} from "./keepalive.js";
import { ownershipKey } from "./supervision.js";
import type { WorkerStatus } from "./status.js";
import { startCacheKeepalive } from "../daemon/daemon/scheduler.js";
import { cacheKeepaliveTimer, setCacheKeepaliveTimer } from "../daemon/daemon/state.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pai-keepalive-"));
}

function writeTranscript(path: string, events: Record<string, unknown>[]): void {
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  duration_ms: 7752,
  duration_api_ms: 7316,
  usage: {
    input_tokens: 15282,
    output_tokens: 16,
    cache_read_input_tokens: 2624,
    cache_creation_input_tokens: 0,
  },
};

describe("parseLastResultEvent", () => {
  it("returns the last result event of a transcript shaped like a real one", () => {
    const dir = tmpDir();
    try {
      const path = join(dir, "w.jsonl");
      writeTranscript(path, [
        { type: "system", subtype: "init", session_id: "s1", _ts: "t" },
        { type: "assistant", message: { usage: { input_tokens: 0, output_tokens: 0 } }, _ts: "t" },
        RESULT,
      ]);
      const e = parseLastResultEvent(path);
      expect(e?.usage?.cache_read_input_tokens).toBe(2624);
      expect(e?.duration_api_ms).toBe(7316);
      expect(e?.num_turns).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the LAST result when several exist", () => {
    const dir = tmpDir();
    try {
      const path = join(dir, "w.jsonl");
      writeTranscript(path, [
        { ...RESULT, usage: { ...RESULT.usage, cache_read_input_tokens: 111 } },
        { ...RESULT, usage: { ...RESULT.usage, cache_read_input_tokens: 222 } },
      ]);
      expect(parseLastResultEvent(path)?.usage?.cache_read_input_tokens).toBe(222);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is null for a missing file and for a transcript without a result", () => {
    const dir = tmpDir();
    try {
      expect(parseLastResultEvent(join(dir, "nope.jsonl"))).toBeNull();
      const path = join(dir, "w.jsonl");
      writeTranscript(path, [{ type: "system", subtype: "init" }]);
      expect(parseLastResultEvent(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractBeatMetrics", () => {
  it("maps the usage fields a beat reports", () => {
    const m = extractBeatMetrics(
      { id: "keepalive-x", ok: true, rc: 0, provider: "glm", model: "glm-5.3-flash" },
      RESULT
    );
    expect(m).toMatchObject({
      id: "keepalive-x",
      ok: true,
      provider: "glm",
      input_tokens: 15282,
      output_tokens: 16,
      cache_read_input_tokens: 2624,
      cache_creation_input_tokens: 0,
      duration_api_ms: 7316,
      duration_ms: 7752,
      num_turns: 1,
    });
  });

  it("yields null metrics when the run ended without a result event", () => {
    const m = extractBeatMetrics(
      { id: "keepalive-x", ok: false, rc: 1, provider: null, model: null },
      null
    );
    expect(m.ok).toBe(false);
    expect(m.cache_read_input_tokens).toBeNull();
    expect(m.duration_api_ms).toBeNull();
  });
});

describe("beat plumbing", () => {
  it("mints second-resolution beat ids", () => {
    expect(beatId(new Date("2026-09-18T12:34:56"))).toBe("keepalive-20260918-123456");
  });

  it("reports no beat in flight outside a run", () => {
    expect(beatBusy()).toBe(false);
  });

  it("carries the trivial heartbeat prompt", () => {
    expect(HEARTBEAT_PROMPT).toMatch(/^Reply with exactly one word/);
  });
});

describe("keepaliveSecs", () => {
  it("is 0 when workers are off, whatever the knob says", () => {
    expect(keepaliveSecs({ enabled: false, cacheKeepaliveSecs: 120 })).toBe(0);
  });

  it("passes the knob through when workers are on", () => {
    expect(keepaliveSecs({ enabled: true, cacheKeepaliveSecs: 120 })).toBe(120);
    expect(keepaliveSecs({ enabled: true, cacheKeepaliveSecs: 0 })).toBe(0);
  });
});

describe("supervision non-interference", () => {
  it("a heartbeat-shaped worker has no owner to notify", () => {
    const beat = {
      id: "keepalive-20260918-123456",
      pid: 1,
      label: "cache-keepalive",
      cwd: "/some/logdir",
      term: "",
      provider: "glm",
      model: "glm-5.3-flash",
      state: "done",
      started: "2026-09-18 12:34:56",
      updated: "2026-09-18 12:35:06",
      turns: 1,
      tools: 0,
      last: "says: pong",
      rc: 0,
      secs: 10,
    } as WorkerStatus;
    expect(beat.spawnerSession).toBeUndefined();
    expect(beat.session).toBeUndefined();
    expect(ownershipKey(beat)).toBeNull();
  });

  it("an ordinary spawner-attributed worker still has one (the contrast)", () => {
    const owned = {
      id: "20260918-120000-1",
      pid: 1,
      label: "real work",
      cwd: "/repo",
      term: "",
      provider: "glm",
      model: "glm-5.3-flash",
      state: "done",
      started: "2026-09-18 12:00:00",
      updated: "2026-09-18 12:01:00",
      turns: 3,
      tools: 2,
      last: "",
      rc: 0,
      secs: 60,
      spawnerSession: "orchestrator-session",
    } as WorkerStatus;
    expect(ownershipKey(owned)).toBe("orchestrator-session");
  });
});

describe("startCacheKeepalive arming", () => {
  afterEach(() => {
    if (cacheKeepaliveTimer) {
      clearInterval(cacheKeepaliveTimer);
      setCacheKeepaliveTimer(null);
    }
    vi.useRealTimers();
  });

  function writeConfig(path: string, workers: Record<string, unknown>): string {
    writeFileSync(path, JSON.stringify({ workers }), "utf8");
    return path;
  }

  it("stays unarmed when workers are off", () => {
    const dir = tmpDir();
    try {
      const path = writeConfig(join(dir, "config.json"), {
        enabled: false,
        cacheKeepaliveSecs: 120,
      });
      startCacheKeepalive({ configPath: path });
      expect(cacheKeepaliveTimer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays unarmed when the knob is 0", () => {
    const dir = tmpDir();
    try {
      const path = writeConfig(join(dir, "config.json"), {
        enabled: true,
        cacheKeepaliveSecs: 0,
      });
      startCacheKeepalive({ configPath: path });
      expect(cacheKeepaliveTimer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("beats at the configured cadence when armed", async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    try {
      const beat = vi.fn(async () => null);
      const path = writeConfig(join(dir, "config.json"), {
        enabled: true,
        cacheKeepaliveSecs: 120,
      });
      startCacheKeepalive({ configPath: path, beat });
      expect(cacheKeepaliveTimer).not.toBeNull();
      expect(beat).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(61_000); // first beat after the startup delay
      expect(beat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000); // then every cacheKeepaliveSecs
      expect(beat).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
