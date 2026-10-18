/**
 * Tests for wait.ts — the deterministic poller. Pure status-file fixtures in
 * a throwaway logDir; the injectable interval/timeout keep every test in the
 * millisecond range.
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWait, waitWorkers } from "./wait.js";
import { nowStamp, saveStatus, type WorkerStatus } from "./status.js";

const logDir = mkdtempSync(join(tmpdir(), "pai-wait-test-"));

mkdirSync(join(logDir, "src"));
writeFileSync(join(logDir, "src", "a.ts"), "x", "utf8"); // the file reportText claims

function status(id: string, over: Partial<WorkerStatus> = {}): void {
  const s: WorkerStatus = {
    id,
    pid: process.pid,
    label: `label ${id}`,
    cwd: logDir,
    term: "",
    provider: "testprov",
    model: "test-1",
    state: "done",
    started: nowStamp(),
    updated: "2026-09-17 10:00:00",
    turns: 1,
    tools: 0,
    last: "",
    rc: 0,
    secs: 1,
    ...over,
  };
  saveStatus(logDir, s);
}

function events(id: string, lines: object[]): void {
  writeFileSync(join(logDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

const reportText = JSON.stringify({ changed: [{ path: "src/a.ts", summary: "s" }], notes: "wait works" });

describe("waitWorkers", () => {
  it("resolves a done worker immediately with result and parsed report", async () => {
    status("done1");
    events("done1", [
      { type: "system", subtype: "init" },
      { type: "result", result: reportText },
    ]);
    const { results, timedOut } = await waitWorkers(logDir, ["done1"], { intervalMs: 5 });
    expect(timedOut).toEqual([]);
    const r = results[0];
    expect(r.id).toBe("done1");
    expect(r.label).toBe("label done1");
    expect(r.state).toBe("done");
    expect(r.ok).toBe(true);
    expect(r.result).toBe(reportText);
    expect(r.report?.notes).toBe("wait works");
  });

  it("takes the LAST result event when several are written", async () => {
    status("done2");
    events("done2", [
      { type: "result", result: '{"notes":"first"}' },
      { type: "result", result: reportText },
    ]);
    const { results } = await waitWorkers(logDir, ["done2"], { intervalMs: 5 });
    expect(results[0].result).toBe(reportText);
  });

  it("marks a failed worker not ok", async () => {
    status("failed1", { state: "failed", rc: 1, secs: 3 });
    events("failed1", [{ type: "result", result: "boom", is_error: true }]);
    const { results } = await waitWorkers(logDir, ["failed1"], { intervalMs: 5 });
    expect(results[0].ok).toBe(false);
    expect(results[0].state).toBe("failed");
    expect(results[0].result).toBe("boom");
    expect(results[0].report).toBeNull(); // plain prose is no report
  });

  it("treats a done worker with a nonzero rc as not ok", async () => {
    status("rc1", { state: "done", rc: 2 });
    const { results } = await waitWorkers(logDir, ["rc1"], { intervalMs: 5 });
    expect(results[0].ok).toBe(false);
  });

  it("throws on an unknown id before any waiting", async () => {
    await expect(waitWorkers(logDir, ["nosuch"], { intervalMs: 5 })).rejects.toThrow(
      /no worker named "nosuch"/
    );
  });

  it("returns timedOut for a worker that never finishes", async () => {
    status("stuck", { state: "running", rc: null, secs: null });
    const { results, timedOut } = await waitWorkers(logDir, ["stuck"], {
      timeoutMs: 60,
      intervalMs: 10,
    });
    expect(timedOut).toEqual(["stuck"]);
    expect(results[0].state).toBe("running");
    expect(results[0].timedOut).toBe(true);
    expect(results[0].ok).toBeUndefined();
    expect(JSON.stringify(results[0])).not.toContain('"ok":false');
  });

  it("picks up a worker that flips to done mid-poll", async () => {
    status("flip", { state: "running", rc: null, secs: null });
    const t = setTimeout(() => {
      status("flip", { state: "done", rc: 0, secs: 4 });
      events("flip", [{ type: "result", result: reportText }]);
    }, 40);
    try {
      const { results, timedOut } = await waitWorkers(logDir, ["flip"], {
        timeoutMs: 2000,
        intervalMs: 15,
      });
      expect(timedOut).toEqual([]);
      expect(results[0].ok).toBe(true);
      expect(results[0].report?.notes).toBe("wait works");
    } finally {
      clearTimeout(t);
    }
  });

  it("runWait --timeout on a running worker: timedOut JSON, no ok, clear stderr, exit 1", async () => {
    status("slow", { state: "running", rc: null, secs: null });
    const out: string[] = [];
    const err: string[] = [];
    const rc = await runWait(logDir, ["slow"], { timeout: 0.05 }, (l) => out.push(l), (l) => err.push(l));
    const j = JSON.parse(out[0]);
    expect(j.state).toBe("running");
    expect(j.timedOut).toBe(true);
    expect("ok" in j).toBe(false);
    expect(err[0]).toMatch(/still running after 0.05s \(wait timed out, worker not affected\)/);
    expect(rc).toBe(1);
  });

  it("finished workers keep ok true/false and no timedOut", async () => {
    const { results } = await waitWorkers(logDir, ["done1", "failed1"], { intervalMs: 5 });
    expect(results.map((r) => [r.ok, r.timedOut])).toEqual([[true, undefined], [false, undefined]]);
  });
});

describe("waitWorkers claim verification", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-wait-claim-"));
  writeFileSync(join(dir, "real.ts"), "x", "utf8");
  const claim = (path: string) => JSON.stringify({ changed: [{ path, summary: "s" }] });
  const started = "2020-01-01 00:00:00";

  it("fabricated claim: ok:false with unconfirmed paths", async () => {
    status("fab", { cwd: dir, started });
    events("fab", [{ type: "result", result: claim("ghost.ts") }]);
    const { results } = await waitWorkers(logDir, ["fab"], { intervalMs: 1, timeoutMs: 50 });
    expect(results[0].ok).toBe(false);
    expect(results[0].unconfirmed).toEqual(["ghost.ts"]);
  });

  it("real change: ok:true, no unconfirmed field", async () => {
    status("real", { cwd: dir, started });
    events("real", [{ type: "result", result: claim("real.ts") }]);
    const { results } = await waitWorkers(logDir, ["real"], { intervalMs: 1, timeoutMs: 50 });
    expect(results[0].ok).toBe(true);
    expect(results[0].unconfirmed).toBeUndefined();
  });

  it("research report without changes: unchanged", async () => {
    status("res", { cwd: dir, started });
    events("res", [{ type: "result", result: JSON.stringify({ notes: "answer" }) }]);
    const { results } = await waitWorkers(logDir, ["res"], { intervalMs: 1, timeoutMs: 50 });
    expect(results[0].ok).toBe(true);
    expect(results[0].unconfirmed).toBeUndefined();
  });
});

describe("isExpectedWaitExit", () => {
  it("wait/wait-file exit 3 is expected", async () => {
    const { isExpectedWaitExit } = await import("./wait.js");
    expect(isExpectedWaitExit("pai worker wait --max 100 abc", 3)).toBe(true);
    expect(isExpectedWaitExit("pai worker wait-file /tmp/x", 3)).toBe(true);
  });
  it("exit 1 and other commands stay errors", async () => {
    const { isExpectedWaitExit } = await import("./wait.js");
    expect(isExpectedWaitExit("pai worker wait abc", 1)).toBe(false);
    expect(isExpectedWaitExit("grep foo bar", 3)).toBe(false);
    expect(isExpectedWaitExit("pai worker wait abc", null)).toBe(false);
  });
});

describe("waitWorkers dead pid", () => {
  it("a running status whose pid is gone is reported lost", async () => {
    status("ghost", { state: "running", pid: 999999, rc: null, secs: null, last: "starting" });
    const { results, timedOut } = await waitWorkers(logDir, ["ghost"], { timeoutMs: 200, intervalMs: 10 });
    expect(timedOut).toEqual([]);
    expect(results[0].state).toBe("lost");
  });
});
