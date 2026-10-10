import { describe, it, expect } from "vitest";
import {
  MAX_DENIALS,
  denialLines,
  denialMark,
  markSpecConflicts,
  parseDenialText,
  recordDenial,
  type Denial,
  type DenialStatus,
} from "./denials.js";
import { paneStatusRow, renderTable } from "./render.js";
import type { WorkerStatus } from "./status.js";

// shape copied from a real worker log (tool_result, is_error)
const REAL = "PreToolUse:Bash hook error: [${PAI_DIR}/Hooks/security-validator.mjs]: No stderr output";
const uses = (cmd: string) => new Map([["t1", { name: "Bash", input: { command: cmd } }]]);
const block = { tool_use_id: "t1", is_error: true };

describe("parseDenialText", () => {
  it("real PreToolUse shape", () =>
    expect(parseDenialText(REAL)).toEqual({
      tool: "Bash",
      hook: "${PAI_DIR}/Hooks/security-validator.mjs",
      reason: "No stderr output",
    }));
  it("permission-rules shape takes the paired tool", () =>
    expect(parseDenialText("Exit code 2\nztk: command denied by permission rules", "Bash")?.hook).toBe("ztk"));
  it("ordinary failure is not a denial", () => expect(parseDenialText("Exit code 1\nboom")).toBeNull());
});

describe("recordDenial", () => {
  it("pairs with its tool_use and trims input/reason", () => {
    const s: DenialStatus = {};
    const long = "git push origin main " + "x".repeat(200);
    expect(recordDenial(s, block, REAL, uses(long), null, "2026-10-10T10:00:00Z")).toBe(true);
    expect(s.denials![0]).toMatchObject({ tool: "Bash", hook: "${PAI_DIR}/Hooks/security-validator.mjs" });
    expect(s.denials![0].input.length).toBe(120);
    expect(s.denialCount).toBe(1);
  });
  it("ignores non-error and non-denial results", () => {
    const s: DenialStatus = {};
    expect(recordDenial(s, { tool_use_id: "t1" }, REAL, uses("ls"), null, "")).toBe(false);
    expect(recordDenial(s, block, "Exit code 1\nboom", uses("ls"), null, "")).toBe(false);
    expect(s.denials).toBeUndefined();
  });
  it("caps the list but keeps the total", () => {
    const s: DenialStatus = {};
    for (let i = 0; i < MAX_DENIALS + 5; i++) recordDenial(s, block, REAL, uses(`cmd ${i}`), null, "");
    expect(s.denials!.length).toBe(MAX_DENIALS);
    expect(s.denialCount).toBe(MAX_DENIALS + 5);
  });
});

describe("specConflict", () => {
  const d = (input: string, reason = "blocked"): Denial => ({
    at: "", tool: "Bash", hook: "h", input, reason, specConflict: false,
  });
  it("same hook/tool/reason twice flags both", () => {
    const l = [d("a"), d("b")];
    markSpecConflicts(l, null);
    expect(l.map((x) => x.specConflict)).toEqual([true, true]);
  });
  it("digits in the reason are normalized", () => {
    const l = [d("a", "timeout 300 over"), d("b", "timeout 600 over")];
    markSpecConflicts(l, null);
    expect(l[0].specConflict).toBe(true);
  });
  it("single denial with input >= 20 chars from the spec flags", () => {
    const l = [d("git push --dry-run origin main")];
    markSpecConflicts(l, "please run git push --dry-run origin main and report");
    expect(l[0].specConflict).toBe(true);
  });
  it("single denial unrelated to the spec stays false", () => {
    const l = [d("rm -rf somewhere/else/entirely")];
    markSpecConflicts(l, "count the files");
    expect(l[0].specConflict).toBe(false);
  });
});

describe("rendering", () => {
  const s: DenialStatus = {};
  recordDenial(s, block, REAL, uses("git push --dry-run origin main"), "run git push --dry-run origin main", "2026-10-10T10:00:00Z");
  it("mark shows count and spec?", () => expect(denialMark(s)).toBe("denied 1 spec?"));
  it("no denials renders nothing", () => expect(denialMark({})).toBe(""));
  it("footer carries the mark", () =>
    expect(paneStatusRow({ label: "g", model: "", started: "2026-10-10 10:00:00", ...s }, new Date("2026-10-10T10:00:05"))).toContain(
      "denied 1 spec?"
    ));
  it("replay lines list the denial", () => expect(denialLines(s).join("\n")).toMatch(/! 10:00:00 Bash .*git push --dry-run/));
  it("ps row shows it", () => {
    const st = {
      id: "w1", pid: 1, label: "L", cwd: "/x/y", term: "", provider: "p", model: "m", state: "done",
      started: "2026-10-10 10:00:00", updated: "2026-10-10 10:00:01", turns: 1, tools: 1, last: "", rc: 0, secs: 3, ...s,
    } as WorkerStatus;
    expect(renderTable((_k: string, t: string) => t, [st], "", new Date("2026-10-10T10:00:05"))).toContain("denied 1 spec?");
  });
});
