import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveStatus, type WorkerStatus } from "../../../workers/status.js";
import { setSlotCurrent } from "../../../workers/worker-id.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const hook = join(__dirname, "worker-note.ts");
const run = (logDir: string, env: Record<string, string>): string =>
  execFileSync(join(__dirname, "../../../../node_modules/.bin/tsx"), [hook, logDir], {
    env: { PATH: process.env.PATH ?? "", HOME: logDir, PAI_WORKER: "1", ...env },
    encoding: "utf8",
  });

describe("worker-note in a pool slot", () => {
  it("delivers the pending note of the job the slot serves", () => {
    const d = mkdtempSync(join(tmpdir(), "pai-worker-note-"));
    dirs.push(d);
    saveStatus(d, {
      id: "pooled1", pid: 1, label: "l", cwd: "/", term: "", provider: "p", model: "m", state: "running",
      started: "2026-01-01 00:00:00", updated: "2026-01-01 00:00:00", turns: 0, tools: 0, last: "", rc: null, secs: null,
      notePending: ["use the other branch"],
    } as WorkerStatus);
    setSlotCurrent(d, "prov-1", "pooled1");
    expect(run(d, { PAI_POOL_SLOT: "prov-1" })).toContain("use the other branch");
    // delivered once
    expect(run(d, { PAI_POOL_SLOT: "prov-1" })).toBe("");
  });
});
