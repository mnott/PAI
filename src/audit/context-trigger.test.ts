import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveSessionTrigger } from "./context-trigger.js";
import { statuslineStateFilePath } from "../hooks/ts/lib/context-fill.js";

let root: string;
let realTmpdir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-context-trigger-test-"));
  // statuslineStateFilePath always resolves against the REAL os.tmpdir(), not
  // the transcript's own temp root — point it at a session-scoped file inside
  // `root` too by overriding TMPDIR for the duration of each test, so a
  // statusline-state test never touches this machine's real tmp files.
  realTmpdir = process.env.TMPDIR ?? "";
  process.env.TMPDIR = root;
});

afterEach(() => {
  if (realTmpdir) process.env.TMPDIR = realTmpdir;
  else delete process.env.TMPDIR;
  rmSync(root, { recursive: true, force: true });
});

function writeJsonl(path: string, entries: unknown[]): void {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

const usageEntry = (model: string, usage: Record<string, number>) => ({
  type: "assistant",
  message: { role: "assistant", model, usage },
});

function writeStatuslineState(sessionId: string, windowSize: number, timestamp: number): void {
  writeFileSync(
    statuslineStateFilePath(sessionId),
    JSON.stringify({ used_percentage: 10, context_window_size: windowSize, session_id: sessionId, timestamp }),
    "utf8"
  );
}

describe("deriveSessionTrigger — window derivation", () => {
  it("prefers a fresh statusline-state file over everything else", () => {
    const sessionId = "session";
    const p = join(root, `${sessionId}.jsonl`);
    writeJsonl(p, [usageEntry("claude-sonnet-5", { input_tokens: 100 })]);
    writeStatuslineState(sessionId, 1_000_000, Date.now());

    const derived = deriveSessionTrigger(p, {});

    expect(derived.window).toBe(1_000_000);
    expect(derived.windowSource).toBe("statusline-state");
  });

  it("accepts a stale statusline-state file as statusline-state-stale", () => {
    const sessionId = "session";
    const p = join(root, `${sessionId}.jsonl`);
    writeJsonl(p, [usageEntry("claude-sonnet-5", { input_tokens: 100 })]);
    writeStatuslineState(sessionId, 1_000_000, Date.now() - 60 * 60 * 1000); // 1h old

    const derived = deriveSessionTrigger(p, {});

    expect(derived.window).toBe(1_000_000);
    expect(derived.windowSource).toBe("statusline-state-stale");
  });

  it("falls back to a transcript context_window field when no statusline file exists", () => {
    const p = join(root, "session.jsonl");
    writeJsonl(p, [
      {
        type: "assistant",
        context_window: 500_000,
        message: { role: "assistant", model: "claude-fable-5-1[1m]", usage: { input_tokens: 100 } },
      },
    ]);

    const derived = deriveSessionTrigger(p, {});

    expect(derived.window).toBe(500_000);
    expect(derived.windowSource).toBe("transcript-field");
  });

  it("falls back to the model id's bracketed window when no statusline file or field exists", () => {
    const p = join(root, "session.jsonl");
    writeJsonl(p, [usageEntry("claude-fable-5-1[1m]", { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);

    const derived = deriveSessionTrigger(p, {});

    expect(derived.window).toBe(1_000_000);
    expect(derived.windowSource).toBe("model-id");
    // No override in env -> DEFAULT_AUTOCOMPACT_PCT (80) of the window, per
    // configuredTrigger's own formula (context-fill.ts).
    expect(derived.trigger).toBe(784_000);
    expect(derived.autocompactPct).toBe(80);
    expect(derived.triggerSource).toBe("configured");
  });

  it("falls back to this transcript's own compaction history for a bare model id", () => {
    const p = join(root, "session.jsonl");
    writeJsonl(p, [
      { type: "system", subtype: "compact_boundary", timestamp: "2026-09-01T00:00:00.000Z", compactMetadata: { preTokens: 784_000 } },
      usageEntry("claude-fable-5-1", { input_tokens: 100 }),
    ]);

    const derived = deriveSessionTrigger(p, {});

    expect(derived.window).toBe(1_000_000);
    expect(derived.windowSource).toBe("compaction-history");
  });

  it("falls back to DEFAULT_CONTEXT_WINDOW (200k) when nothing above resolves", () => {
    const p = join(root, "session.jsonl");
    writeJsonl(p, [usageEntry("claude-sonnet-5", { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);

    const derived = deriveSessionTrigger(p, {});

    expect(derived.window).toBe(200_000);
    expect(derived.windowSource).toBe("default");
    expect(derived.trigger).toBe(144_000); // configuredTrigger(200_000, 80)
  });

  it("honours CLAUDE_AUTOCOMPACT_PCT_OVERRIDE from the given env", () => {
    const p = join(root, "session.jsonl");
    writeJsonl(p, [usageEntry("claude-fable-5-1[1m]", { input_tokens: 100 })]);

    const derived = deriveSessionTrigger(p, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" });

    expect(derived.window).toBe(1_000_000);
    expect(derived.trigger).toBe(490_000); // configuredTrigger(1_000_000, 50)
    expect(derived.autocompactPct).toBe(50);
  });
});
