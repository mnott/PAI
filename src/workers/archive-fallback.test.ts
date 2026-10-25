import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveOldStatuses } from "./archive-statuses.js";
import { loadArchivedStatuses, loadStatus, loadStatuses } from "./status.js";
import { eventsPath, withArchive } from "./paths.js";
import { replayOutput } from "./viewer.js";
import { workerUsage } from "./usage.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("archive fallback", () => {
  it("finds an archived id through loadStatus, withArchive, replay and usage", () => {
    const d = mkdtempSync(join(tmpdir(), "arch-fb-"));
    dirs.push(d);
    mkdirSync(join(d, "empty"));
    const now = Date.now();
    const old = new Date(now - 20 * 24 * 3_600_000);
    const st = { id: "w-old", state: "done", cwd: d, label: "old one", provider: "p", model: "m", started: old.toISOString().slice(0, 19).replace("T", " ") };
    writeFileSync(join(d, "w-old.status"), JSON.stringify(st));
    writeFileSync(join(d, "w-old.jsonl"), JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 5, output_tokens: 7 } } }) + "\n" + JSON.stringify({ type: "result", result: "hello archive" }) + "\n");
    utimesSync(join(d, "w-old.status"), old, old);
    expect(archiveOldStatuses(d, now)).toEqual(["w-old"]);
    expect(loadStatuses(d).map((s) => s.id)).toEqual([]);
    expect(loadStatus(d, "w-old")?.label).toBe("old one");
    expect(loadStatus(d, "nope")).toBeNull();
    expect(withArchive(d, eventsPath(d, "w-old"))).toContain("archive");
    expect(withArchive(d, eventsPath(d, "nope"))).toBe(eventsPath(d, "nope"));
    expect(loadArchivedStatuses(d).map((s) => s.id)).toEqual(["w-old"]);
    expect(replayOutput(d, "w-old", false)).toContain("hello archive");
    expect(workerUsage(d, {}, {}).rows.length).toBe(1);
    expect(workerUsage(d, { since: new Date(now - 3_600_000) }, {}).rows.length).toBe(0);
  });
});
