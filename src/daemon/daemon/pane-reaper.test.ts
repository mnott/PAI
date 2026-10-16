import { describe, expect, it } from "vitest";
import { paneReapable } from "./scheduler.js";
import type { WorkerStatus } from "../../workers/status.js";

const st = (state: string, updated: string) => ({ state, updated }) as unknown as WorkerStatus;
const now = Date.parse("2026-10-16T10:00:00");

describe("paneReapable", () => {
  it("keeps running workers and unknown ids", () => {
    expect(paneReapable(st("running", "2026-10-16 09:00:00"), now)).toBe(false);
    expect(paneReapable(null, now)).toBe(false);
  });
  it("waits out the 60 s grace after the end", () => {
    expect(paneReapable(st("done", "2026-10-16 09:59:30"), now)).toBe(false);
    expect(paneReapable(st("killed", "2026-10-16 09:58:00"), now)).toBe(true);
  });
});
