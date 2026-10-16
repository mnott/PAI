import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisionTick, supervisionEventsPath } from "./supervision.js";
import { recordToolError } from "./tool-errors.js";
import type { WorkerStatus } from "./status.js";
import { summarizeToolInput, toolErrorText, detectToolErrors, groupToolErrors, normalizeError, RESEND_MS, type ToolErrorRecord } from "./tool-errors.js";

const rec = (worker: string, ts: number, raw: string, tool = "Read"): ToolErrorRecord => ({
  ts, worker, provider: "p", label: "l", tool, raw, signature: normalizeError(tool, raw),
});
const NOW = 10_000_000_000;

describe("normalizeError", () => {
  it("masks paths", () => {
    expect(normalizeError("Read", "File does not exist. Note: your current working directory is /a/b/c")).toBe(
      "Read|File does not exist. Note: your current working directory is <P>"
    );
    expect(normalizeError("Read", "File does not exist. Note: your current working directory is /x/y")).toBe(
      normalizeError("Read", "File does not exist. Note: your current working directory is /a/b/c")
    );
  });
  it("keeps the fixed Edit text", () => {
    expect(normalizeError("Edit", "No changes to make: old_string and new_string are exactly the same")).toBe(
      "Edit|No changes to make: old_string and new_string are exactly the same"
    );
  });
  it("masks quotes, numbers, ids", () => {
    expect(normalizeError("Bash", "worker 20261015-221657-31618 failed 500 on 'abc'")).toBe("Bash|worker <ID> failed <N> on <S>");
  });
  it("hook error", () => {
    const n = normalizeError("Read", "PreToolUse:Read hook error: Your working directory is /w/x. Paths outside it");
    expect(n).toBe("Read|PreToolUse:Read hook error: Your working directory is <P> Paths outside it".replace("<P> Paths", "<P> Paths"));
  });
});

describe("detectToolErrors", () => {
  const t = "File does not exist.";
  it("a: three in one worker", () => {
    const r = [rec("w1", NOW - 3, t), rec("w1", NOW - 2, t), rec("w1", NOW - 1, t)];
    expect(detectToolErrors(r, NOW, {})).toHaveLength(1);
    expect(detectToolErrors(r.slice(0, 2), NOW, {})).toHaveLength(0);
  });
  it("b: two workers within 30 min, not outside", () => {
    expect(detectToolErrors([rec("w1", NOW - 1000, t), rec("w2", NOW - 500, t)], NOW, {})).toHaveLength(1);
    expect(detectToolErrors([rec("w1", NOW - 31 * 60_000, t), rec("w2", NOW - 500, t)], NOW, {})).toHaveLength(0);
  });
  it("c: hook error needs 2 in one worker or 1 each in 2 workers", () => {
    const h = "PreToolUse:Read hook error: nope";
    expect(detectToolErrors([rec("w1", NOW - 1, h)], NOW, {})).toHaveLength(0);
    expect(detectToolErrors([rec("w1", NOW - 2, h), rec("w1", NOW - 1, h)], NOW, {})).toHaveLength(1);
    expect(detectToolErrors([rec("w1", NOW - 2, h), rec("w2", NOW - 1, h)], NOW, {})).toHaveLength(1);
    expect(detectToolErrors([rec("w1", NOW - 2, "plain failure"), rec("w1", NOW - 1, "plain failure")], NOW, {})).toHaveLength(0);
  });
  it("dedupes within 30 min, re-sends after", () => {
    const r = [rec("w1", NOW - 3, t), rec("w1", NOW - 2, t), rec("w1", NOW - 1, t)];
    const sent: Record<string, number> = {};
    expect(detectToolErrors(r, NOW, sent)).toHaveLength(1);
    expect(detectToolErrors(r, NOW + 1000, sent)).toHaveLength(0);
    expect(detectToolErrors(r, NOW + RESEND_MS + 1, sent)).toHaveLength(1);
  });
  it("groups", () => {
    const g = groupToolErrors([rec("w1", 1, t), rec("w2", 5, t)]);
    expect(g[0]).toMatchObject({ count: 2, first: 1, last: 5, lastWorker: "w2" });
  });
});

describe("supervision tick", () => {
  it("records, messages the owner once, and not again within 30 min", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-toolerr-"));
    try {
      const now = new Date();
      const st = {
        id: "20261016-000000-1", pid: 1, label: "l", cwd: "/", term: "", provider: "p", model: "m", state: "running",
        started: "2026-10-16 00:00:00", updated: "2026-10-16 00:00:00", turns: 1, tools: 1, last: "", rc: null, secs: null,
        spawnerSession: "sess-1",
      } as unknown as WorkerStatus;
      for (let i = 0; i < 3; i++) {
        recordToolError(dir, { worker: st.id, provider: "p", label: "l", tool: "Read", text: `File does not exist. Note: your current working directory is /t/${i}` }, now.getTime());
      }
      const pushed: string[] = [];
      const push = async (_d: string, _t: unknown, ev: { text: string }) => (pushed.push(ev.text), true);
      const opts = { now, isAlive: () => true, statuses: [st], stallMs: 1e12, push };
      const r1 = await runSupervisionTick(dir, opts);
      expect(r1.events.filter((e) => e.kind === "toolerror")).toHaveLength(1);
      expect(pushed[0]).toMatch(/^systematic error Read\|File does not exist.*<P> ×3 in 20261016-000000-1 — sample: /);
      expect(readFileSync(supervisionEventsPath(dir, "sess-1"), "utf8")).toContain("toolerror");
      const r2 = await runSupervisionTick(dir, opts);
      expect(r2.events.filter((e) => e.kind === "toolerror")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tool input", () => {
  it("summarizes path, pattern, command", () => {
    expect(summarizeToolInput({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolInput({ path: "/src", pattern: "foo" })).toBe("/src foo");
    expect(summarizeToolInput({ command: "x".repeat(300) })).toHaveLength(200);
    expect(summarizeToolInput(null)).toBeUndefined();
  });
  it("alert shows input and rule b counts only recent workers", () => {
    const old = rec("old", NOW - 33 * 60_000, "File does not exist");
    const a = { ...rec("w1", NOW - 2000, "File does not exist"), input: "/x/y.ts" };
    const b = rec("w2", NOW - 1000, "File does not exist");
    const [g] = detectToolErrors([old, a, b], NOW, {});
    expect(g.workers).toEqual(["w1", "w2"]);
    expect(toolErrorText(groupToolErrors([a])[0])).toContain("(input: /x/y.ts)");
  });
});
