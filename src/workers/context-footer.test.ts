import { describe, it, expect } from "vitest";
import { certainContextWindow } from "../utils/model-window.js";
import { usageContextUsed } from "./run.js";
import { contextFooter, fmtTokens } from "./status.js";
import { paneStatusRow } from "./render.js";

describe("certainContextWindow", () => {
  it("[1m] suffix is 1M", () => expect(certainContextWindow("claude-sonnet-5-5[1m]")).toBe(1_000_000));
  it("plain claude id is 200k", () => expect(certainContextWindow("claude-sonnet-5-5")).toBe(200_000));
  it("unknown id is undefined-ish (null)", () => expect(certainContextWindow("qwen3-coder")).toBeNull());
});

describe("usageContextUsed", () => {
  it("sums input + cache read + cache creation, not output", () => {
    expect(
      usageContextUsed({
        input_tokens: 10,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 8_000,
        output_tokens: 999,
      })
    ).toBe(48_010);
  });
  it("no usage reads null", () => expect(usageContextUsed(undefined)).toBeNull());
});

describe("context footer", () => {
  const s = { label: "g", model: "claude-sonnet-5-5", started: "2026-09-17 10:00:00" };
  const now = new Date("2026-09-17T10:00:45");
  it("formats k and M", () => {
    expect(fmtTokens(48_000)).toBe("48k");
    expect(fmtTokens(1_000_000)).toBe("1M");
  });
  it("known window", () => {
    expect(paneStatusRow({ ...s, contextUsed: 48_000, contextWindow: 200_000 }, now)).toBe(
      "g · sonnet-5.5 · 48k / 200k · started 10:00 · 45s"
    );
  });
  it("a run waiting in the stagger gate reads waiting (warm-up) instead of its goal", () => {
    const warmup = { for: "w0", provider: "local30x8", elapsedSec: 7, limitSec: 12 };
    const row = paneStatusRow({ ...s, warmup }, now);
    expect(row).toContain("waiting (warm-up) 7s/12s");
    expect(row).not.toContain("g ·");
    expect(paneStatusRow(s, now)).toContain("g ·");
  });
  it("unknown window shows only used", () => {
    expect(contextFooter({ contextUsed: 48_000, contextWindow: null })).toBe("48k");
  });
});
