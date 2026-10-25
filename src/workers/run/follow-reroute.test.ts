import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followRerouted } from "./follow-reroute.js";
import { saveStatus, type WorkerStatus } from "../status.js";
import { eventsPath } from "../paths.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "follow-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const st = (over: Partial<WorkerStatus>): WorkerStatus =>
  ({ id: "w1", pid: 1, label: "l", cwd: "/", term: "", provider: "p", model: "m", state: "killed", started: "", updated: "", turns: 0, tools: 0, last: "", rc: 143, secs: 0, ...over }) as WorkerStatus;

describe("followRerouted", () => {
  it("prints the new run's result and returns its rc instead of 143", async () => {
    saveStatus(dir, st({ rerouted: "anthropic: queued 15m", fallThroughTo: "w2" }));
    saveStatus(dir, st({ id: "w2", state: "done", rc: 0 }));
    writeFileSync(eventsPath(dir, "w2"), `${JSON.stringify({ type: "result", result: "R from w2" })}\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await followRerouted(dir, "w1", "json", { pollMs: 5 })).toBe(0);
    expect(log.mock.calls[0]![0]).toContain("R from w2");
  });

  it("names the old id and returns 143 when no new run appears", async () => {
    saveStatus(dir, st({ rerouted: "anthropic: queued 15m" }));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await followRerouted(dir, "w1", "json", { pollMs: 5, appearMs: 20 })).toBe(143);
    expect(String(err.mock.calls[0]![0])).toContain("w1 was rerouted");
  });
});
