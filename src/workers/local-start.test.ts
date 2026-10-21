import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearLocalStart, failLocalStart, localStartView, readLocalStart, writeLocalStart } from "./local-start.js";

const base = { tier: "coder-next", provider: "coder-next", port: 8034, startedAt: 1_000_000, readyMs: 600_000, log: "/l/coder-next.log" };

describe("localStartView", () => {
  it("is loading with the seconds since the request, until readyMs", () => {
    expect(localStartView(base, 1_042_000)).toMatchObject({ state: "loading", sinceSec: 42 });
  });
  it("times out into failed with the log path", () => {
    expect(localStartView(base, 1_000_000 + 600_001)).toMatchObject({ state: "failed", message: "failed to start, see /l/coder-next.log" });
  });
  it("a start marked failed is failed at once", () => {
    expect(localStartView({ ...base, failed: "server exited (1)" }, 1_001_000)?.state).toBe("failed");
  });
  it("null when nothing is starting", () => expect(localStartView(null)).toBeNull());
});

describe("record file", () => {
  it("write, fail, clear", () => {
    const d = mkdtempSync(join(tmpdir(), "pai-start-"));
    expect(readLocalStart(d)).toBeNull();
    writeLocalStart(d, base);
    expect(readLocalStart(d)).toEqual(base);
    failLocalStart(d, "x");
    expect(readLocalStart(d)?.failed).toBe("x");
    clearLocalStart(d);
    expect(readLocalStart(d)).toBeNull();
  });
});
