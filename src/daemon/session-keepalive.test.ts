/**
 * Tests for the interactive-session cache keepalive: idle/hours/context/
 * max-beats gating, the mid-turn guard, the reset-on-real-prompt rule, and
 * the ledger line shape. Every dependency (session list, transcript lookup,
 * mtime, send) is injected — no AIBroker socket, no real filesystem walk of
 * ~/.claude/projects, no live config.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSessionKeepaliveTick,
  isWithinActiveHours,
  parseActiveHours,
  readTranscriptSnapshot,
  loadSessionKeepaliveState,
  saveSessionKeepaliveState,
  resolveClaudeSessionIdFromMap,
  type SessionKeepaliveDeps,
  type SessionKeepaliveState,
} from "./session-keepalive.js";
import type { SessionsCacheKeepaliveConfig } from "./config.js";
import type { AiBrokerSessionMeta } from "../cli/lib/aibroker-client.js";
import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { worktreesDir } from "../workers/worktree.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pai-session-keepalive-"));
}

function config(overrides: Partial<SessionsCacheKeepaliveConfig> = {}): SessionsCacheKeepaliveConfig {
  return {
    enabled: true,
    idleMinutes: 50,
    maxBeats: 6,
    activeHours: "08:00-22:00",
    minContextTokens: 20_000,
    prompt: "keepalive",
    ...overrides,
  };
}

function meta(sessionId: string): AiBrokerSessionMeta {
  return { index: 0, sessionId, name: "tab", paiName: "Test", atPrompt: true, kind: "claude", active: false };
}

function assistantLine(usage: Record<string, number>, opts: { stopReason?: string | null; uuid?: string } = {}) {
  return {
    type: "assistant",
    uuid: opts.uuid ?? "a1",
    timestamp: "2026-09-20T10:00:00.000Z",
    message: { id: opts.uuid ?? "a1", model: "m", usage, stop_reason: opts.stopReason ?? "end_turn" },
  };
}

function userLine(text: string, uuid: string) {
  return { type: "user", uuid, timestamp: "2026-09-20T09:00:00.000Z", message: { content: text } };
}

function baseDeps(overrides: Partial<SessionKeepaliveDeps> = {}): SessionKeepaliveDeps {
  const ledgerLines: string[] = [];
  let state: SessionKeepaliveState = {};
  return {
    now: () => new Date("2026-09-20T12:00:00"),
    fetchLiveSessions: async () => [meta("sess-1")],
    resolveClaudeSessionId: (paneId) => paneId,
    findTranscript: () => "/fake/sess-1.jsonl",
    mtimeMs: () => new Date("2026-09-20T12:00:00").getTime() - 60 * 60_000, // 60 min idle
    readSnapshot: () => ({ context: 30_000, midTurn: false, lastRealPrompt: null }),
    sendBeat: async () => ({ ok: true }),
    loadState: () => state,
    saveState: (s) => {
      state = s;
    },
    ledger: (kv) => {
      ledgerLines.push(JSON.stringify(kv));
    },
    ...overrides,
  };
}

describe("isWithinActiveHours / parseActiveHours", () => {
  it("parses a plain HH:MM-HH:MM window", () => {
    expect(parseActiveHours("08:00-22:00")).toEqual({ startMin: 480, endMin: 1320 });
  });

  it("rejects a malformed spec", () => {
    expect(() => parseActiveHours("garbage")).toThrow();
  });

  it("is true inside a same-day window, false outside", () => {
    expect(isWithinActiveHours(new Date("2026-09-20T12:00:00"), "08:00-22:00")).toBe(true);
    expect(isWithinActiveHours(new Date("2026-09-20T23:00:00"), "08:00-22:00")).toBe(false);
    expect(isWithinActiveHours(new Date("2026-09-20T06:00:00"), "08:00-22:00")).toBe(false);
  });

  it("handles a window that wraps midnight", () => {
    expect(isWithinActiveHours(new Date("2026-09-20T23:00:00"), "22:00-06:00")).toBe(true);
    expect(isWithinActiveHours(new Date("2026-09-20T12:00:00"), "22:00-06:00")).toBe(false);
  });
});

describe("readTranscriptSnapshot", () => {
  let dir: string;

  function cleanup() {
    rmSync(dir, { recursive: true, force: true });
  }

  it("reads the last turn's context and flags idle-safe when stop_reason is end_turn", () => {
    dir = tmpDir();
    const path = join(dir, "t.jsonl");
    writeFileSync(
      path,
      [userLine("hello", "u1"), assistantLine({ cache_read_input_tokens: 25_000, input_tokens: 100 })]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n"
    );
    const snap = readTranscriptSnapshot(path);
    expect(snap.context).toBe(25_100);
    expect(snap.midTurn).toBe(false);
    expect(snap.lastRealPrompt).toEqual({ key: "u1", text: "hello" });
    cleanup();
  });

  it("flags mid-turn when the last assistant line has no usage yet (streaming)", () => {
    dir = tmpDir();
    const path = join(dir, "t.jsonl");
    writeFileSync(path, JSON.stringify({ type: "assistant", uuid: "a1", message: { id: "a1" } }) + "\n");
    expect(readTranscriptSnapshot(path).midTurn).toBe(true);
    cleanup();
  });

  it("flags mid-turn when the last assistant line's stop_reason is tool_use", () => {
    dir = tmpDir();
    const path = join(dir, "t.jsonl");
    writeFileSync(
      path,
      JSON.stringify(assistantLine({ input_tokens: 10 }, { stopReason: "tool_use" })) + "\n"
    );
    expect(readTranscriptSnapshot(path).midTurn).toBe(true);
    cleanup();
  });

  it("does not count a tool_result user line as a real prompt", () => {
    dir = tmpDir();
    const path = join(dir, "t.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ type: "user", uuid: "u1", message: { content: [{ type: "tool_result", text: "x" }] } }) + "\n"
    );
    expect(readTranscriptSnapshot(path).lastRealPrompt).toBeNull();
    cleanup();
  });
});

describe("resolveClaudeSessionIdFromMap", () => {
  it("matches by pane UUID suffix and picks the newest entry", () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "claude-session-map.json"),
      JSON.stringify({
        "/repo/a": { session: "claude-old", ts: 100, term: "w1t0p0:PANE-UUID" },
        "/repo/b": { session: "claude-new", ts: 200, term: "w2t0p0:PANE-UUID" },
        "/repo/c": { session: "claude-other", ts: 300, term: "w1t0p0:OTHER-UUID" },
      })
    );
    expect(resolveClaudeSessionIdFromMap("PANE-UUID", dir)).toBe("claude-new");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no entry's pane UUID matches", () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "claude-session-map.json"),
      JSON.stringify({ "/repo/a": { session: "claude-old", ts: 100, term: "w1t0p0:OTHER-UUID" } })
    );
    expect(resolveClaudeSessionIdFromMap("PANE-UUID", dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the map file does not exist", () => {
    const dir = tmpDir();
    expect(resolveClaudeSessionIdFromMap("PANE-UUID", dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("session state file", () => {
  it("round-trips through loadSessionKeepaliveState/saveSessionKeepaliveState", () => {
    const dir = tmpDir();
    const path = join(dir, "state.json");
    expect(loadSessionKeepaliveState(path)).toEqual({});
    saveSessionKeepaliveState({ "sess-1": { beats: 2, lastRealPromptKey: "u1", lastBeatAt: "2026-09-20T10:00:00.000Z" } }, path);
    expect(loadSessionKeepaliveState(path)).toEqual({
      "sess-1": { beats: 2, lastRealPromptKey: "u1", lastBeatAt: "2026-09-20T10:00:00.000Z" },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts fresh (not throwing) on a damaged state file", () => {
    const dir = tmpDir();
    const path = join(dir, "state.json");
    writeFileSync(path, "{not json", "utf8");
    expect(loadSessionKeepaliveState(path)).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runSessionKeepaliveTick", () => {
  it("does nothing when disabled", async () => {
    const results = await runSessionKeepaliveTick(config({ enabled: false }), baseDeps());
    expect(results).toEqual([]);
  });

  it("sends a beat when idle >= idleMinutes, inside hours, context high enough, not mid-turn", async () => {
    const results = await runSessionKeepaliveTick(config(), baseDeps());
    expect(results).toEqual([{ sessionId: "sess-1", result: "sent" }]);
  });

  it("skips when idle time is under idleMinutes", async () => {
    const results = await runSessionKeepaliveTick(
      config(),
      baseDeps({ mtimeMs: () => new Date("2026-09-20T12:00:00").getTime() - 5 * 60_000 })
    );
    expect(results[0].result).toMatch(/^skipped:idle:/);
  });

  it("skips outside active hours", async () => {
    const results = await runSessionKeepaliveTick(
      config(),
      baseDeps({ now: () => new Date("2026-09-20T23:30:00") })
    );
    expect(results).toEqual([{ sessionId: "sess-1", result: "skipped:hours" }]);
  });

  it("skips when context is under minContextTokens", async () => {
    const results = await runSessionKeepaliveTick(
      config(),
      baseDeps({ readSnapshot: () => ({ context: 1_000, midTurn: false, lastRealPrompt: null }) })
    );
    expect(results).toEqual([{ sessionId: "sess-1", result: "skipped:context" }]);
  });

  it("skips a session that is mid-turn", async () => {
    const results = await runSessionKeepaliveTick(
      config(),
      baseDeps({ readSnapshot: () => ({ context: 30_000, midTurn: true, lastRealPrompt: null }) })
    );
    expect(results).toEqual([{ sessionId: "sess-1", result: "skipped:mid-turn" }]);
  });

  it("skips a pane with no mapped Claude session, and sends no beat", async () => {
    let sendBeatCalled = false;
    const results = await runSessionKeepaliveTick(
      config(),
      baseDeps({
        resolveClaudeSessionId: () => null,
        sendBeat: async () => {
          sendBeatCalled = true;
          return { ok: true };
        },
      })
    );
    expect(results).toEqual([{ sessionId: "sess-1", result: "skipped:unmapped" }]);
    expect(sendBeatCalled).toBe(false);
  });

  it("skips a session with no transcript found", async () => {
    const results = await runSessionKeepaliveTick(config(), baseDeps({ findTranscript: () => null }));
    expect(results).toEqual([{ sessionId: "sess-1", result: "skipped:no-transcript" }]);
  });

  it("caps at maxBeats per idle stretch", async () => {
    let state: SessionKeepaliveState = { "sess-1": { beats: 6, lastRealPromptKey: null, lastBeatAt: null } };
    const deps = baseDeps({
      loadState: () => state,
      saveState: (s) => {
        state = s;
      },
    });
    const results = await runSessionKeepaliveTick(config({ maxBeats: 6 }), deps);
    expect(results).toEqual([{ sessionId: "sess-1", result: "skipped:max-beats" }]);
  });

  it("resets the beat counter when a real (non-keepalive) prompt appears since the last observation", async () => {
    let state: SessionKeepaliveState = { "sess-1": { beats: 6, lastRealPromptKey: "old-uuid", lastBeatAt: null } };
    const deps = baseDeps({
      loadState: () => state,
      saveState: (s) => {
        state = s;
      },
      readSnapshot: () => ({ context: 30_000, midTurn: false, lastRealPrompt: { key: "new-uuid", text: "do the thing" } }),
    });
    const results = await runSessionKeepaliveTick(config({ maxBeats: 6 }), deps);
    // beats reset to 0, then incremented by the beat this tick sends → 1
    expect(results).toEqual([{ sessionId: "sess-1", result: "sent" }]);
    expect(state["sess-1"].beats).toBe(1);
    expect(state["sess-1"].lastRealPromptKey).toBe("new-uuid");
  });

  it("does NOT reset the beat counter when the observed prompt is the keepalive's own echo", async () => {
    let state: SessionKeepaliveState = { "sess-1": { beats: 6, lastRealPromptKey: "old-uuid", lastBeatAt: null } };
    const deps = baseDeps({
      loadState: () => state,
      saveState: (s) => {
        state = s;
      },
      readSnapshot: () => ({ context: 30_000, midTurn: false, lastRealPrompt: { key: "new-uuid", text: "keepalive" } }),
    });
    const results = await runSessionKeepaliveTick(config({ maxBeats: 6 }), deps);
    expect(results).toEqual([{ sessionId: "sess-1", result: "skipped:max-beats" }]);
    expect(state["sess-1"].beats).toBe(6);
    // the echo's key is still recorded so it isn't re-evaluated every tick
    expect(state["sess-1"].lastRealPromptKey).toBe("new-uuid");
  });

  it("records a ledger line for every session on every tick", async () => {
    const lines: Record<string, unknown>[] = [];
    await runSessionKeepaliveTick(config(), baseDeps({ ledger: (kv) => lines.push(kv) }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ session: "sess-1", result: "sent" });
  });

  it("skips (does not count against maxBeats) when the send itself fails", async () => {
    let state: SessionKeepaliveState = {};
    const deps = baseDeps({
      loadState: () => state,
      saveState: (s) => {
        state = s;
      },
      sendBeat: async () => ({ ok: false, error: "boom" }),
    });
    const results = await runSessionKeepaliveTick(config(), deps);
    expect(results).toEqual([{ sessionId: "sess-1", result: "skipped:send-failed" }]);
    expect(state["sess-1"]).toBeUndefined();
  });

  it("ignores non-claude (shell) live sessions", async () => {
    const results = await runSessionKeepaliveTick(
      config(),
      baseDeps({ fetchLiveSessions: async () => [{ ...meta("sess-1"), kind: "shell" }] })
    );
    expect(results).toEqual([]);
  });

  it("skips a worker session whose transcript lives under an encoded worktree dir", async () => {
    const { workers } = readWorkersSection();
    const encodedWorktreeDir = worktreesDir(workersLogDir(workers)).replace(/\//g, "-") + "-w1";
    const results = await runSessionKeepaliveTick(
      config(),
      baseDeps({ findTranscript: () => `/Users/tester/.claude/projects/${encodedWorktreeDir}/sess-1.jsonl` })
    );
    expect(results).toEqual([{ sessionId: "sess-1", result: "skipped:worker" }]);
  });

  it("still beats a normal (non-worker) project session", async () => {
    const results = await runSessionKeepaliveTick(
      config(),
      baseDeps({ findTranscript: () => "/Users/tester/.claude/projects/-Users-tester-repo/sess-1.jsonl" })
    );
    expect(results).toEqual([{ sessionId: "sess-1", result: "sent" }]);
  });
});
