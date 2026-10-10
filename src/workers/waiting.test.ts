import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shortCmd,
  waitingLine,
  waitOnCallLine,
  waitOnResultLine,
  detachedLine,
  type WaitDeps,
} from "./waiting.js";
import { applyEvent, initialFollowState } from "./viewer.js";
import { makeColor, renderTable, paneStatusRow } from "./render.js";
import { nowStamp, type WorkerStatus } from "./status.js";

const NOW = 10_000_000;
const alive = (cmd: string, startedAt: number | null, log = ""): WaitDeps => ({
  proc: () => ({ cmd, startedAt }),
  logTail: () => log,
});
const gone: WaitDeps = { proc: () => null, logTail: () => "" };
const c = makeColor(false);

describe("shortCmd", () => {
  it("strips nohup, the shell wrapper and the rc trailer", () => {
    expect(shortCmd("nohup sh -c 'tools/batch.sh --land recovery/747; echo $? > /tmp/job.rc'")).toBe(
      "tools/batch.sh --land recovery/747"
    );
    expect(shortCmd("/bin/bash -c \"make all\"")).toBe("make all");
    expect(shortCmd("node /opt/x/run.js --fast")).toBe("/opt/x/run.js --fast");
  });
  it("ends with an ellipsis when too long", () => {
    const s = shortCmd("tools/batch.sh " + "x".repeat(100), 30);
    expect(s).toHaveLength(30);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("waitingLine", () => {
  const w = { pid: 7, cmd: "sleep 120", startedAt: NOW - 252_000, log: "/tmp/x.log" };
  it("names the job, the pid's own running time and the log tail", () => {
    expect(waitingLine(w, NOW, alive("sleep 120", NOW - 252_000, "step 3 of 9"))).toBe(
      "waiting on: sleep 120 · running 4m12s · log: step 3 of 9"
    );
  });
  it("drops the log part without --log or an empty log", () => {
    expect(waitingLine({ ...w, log: null }, NOW, alive("sleep 120", w.startedAt, "x"))).toBe(
      "waiting on: sleep 120 · running 4m12s"
    );
    expect(waitingLine(w, NOW, alive("sleep 120", w.startedAt, ""))).toBe("waiting on: sleep 120 · running 4m12s");
  });
  it("says ended when the pid is gone or was reused", () => {
    expect(waitingLine(w, NOW, gone)).toBe("waiting on: sleep 120 · ended");
    expect(waitingLine(w, NOW, alive("other", NOW - 1000))).toBe("waiting on: sleep 120 · ended");
  });
});

describe("transcript lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "waiting-"));
  const pidFile = join(dir, "b.pid");
  writeFileSync(pidFile, "7\n");
  const cmd = `pai worker wait-on $(cat ${pidFile}) --log /tmp/b.log | tail -5`;

  it("wait-on call reads as the job, resolved through the pid file", () => {
    expect(waitOnCallLine(cmd, NOW, alive("sleep 120", NOW - 5000, "tick"))).toBe(
      "waiting on: sleep 120 · running 0m05s · log: tick"
    );
    expect(waitOnCallLine("ls -la")).toBeNull();
  });
  it("wait-on result reads as done / still running", () => {
    expect(waitOnResultLine("pid 7 gone after 6m03s, exit code 0\nlog line")).toBe("done (exit 0) after 6m03s");
    expect(waitOnResultLine("still running after 115s (pid 7); call wait-on again")).toBe(
      "still running after 115s (pid 7), waiting again"
    );
  });
  it("detached start reads as started in the background", () => {
    expect(detachedLine("nohup sh -c 'tools/batch.sh --land r/7; echo $? > /tmp/j.rc' > /tmp/j.log 2>&1 & echo $! > /tmp/j.pid")).toBe(
      "started in the background: tools/batch.sh --land r/7"
    );
    expect(detachedLine("echo a && echo b")).toBeNull();
  });
  it("follow renders both cases instead of the raw command", () => {
    const ev = (name: string, command: string) => ({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name, input: { command } }] },
    });
    let st = initialFollowState();
    const bg = applyEvent(c, st, ev("Bash", "nohup sh -c 'make all; echo $? > /tmp/j.rc' > /tmp/j.log 2>&1 & echo $! > /tmp/j.pid"), "/");
    expect(bg.lines.join("\n")).toContain("started in the background: make all");
    expect(bg.lines.join("\n")).not.toContain("nohup");
    st = bg.state;
    const wait = applyEvent(c, st, ev("Bash", cmd.replace(pidFile, "/nonexistent/p.pid")), "/");
    expect(wait.lines.join("\n")).toContain("waiting on:");
    expect(wait.lines.join("\n")).not.toContain("wait-on");
    const res = applyEvent(
      c,
      wait.state,
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "pid 7 gone after 6m03s, exit code 0" }] } },
      "/"
    );
    expect(res.lines.join("\n")).toContain("done (exit 0) after 6m03s");
  });
});

describe("renderers", () => {
  const base = {
    id: "w1", pid: 1, label: "goal text", cwd: "/p", term: "", provider: "p", model: "m", state: "running",
    started: nowStamp(), updated: nowStamp(), turns: 1, tools: 1, last: "Bash: pai worker wait-on $(cat /tmp/x.pid)",
    rc: null, secs: null, pid_: 0,
  } as unknown as WorkerStatus;
  // pid of this very process: alive, so the line reads as running
  const waiting = { ...base, pid: process.pid, waitingOn: { pid: process.pid, cmd: "sleep 120", startedAt: null, log: null } } as WorkerStatus;

  it("ps row prefers waitingOn over the raw now: text", () => {
    const t = renderTable(c, [waiting], "all", new Date());
    expect(t).toContain("waiting on: sleep 120");
    expect(t).not.toContain("now:");
    expect(renderTable(c, [{ ...base, pid: process.pid }], "all", new Date())).toContain("now:");
  });
  it("pane footer replaces the goal with the wait", () => {
    expect(paneStatusRow(waiting, new Date(), 200)).toContain("waiting on: sleep 120");
    expect(paneStatusRow(base, new Date(), 200)).toContain("goal text");
  });
});
