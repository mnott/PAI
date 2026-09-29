import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callerDescription, decideEndReason, endLabel, killMarkerPath, requestKill } from "./endreason.js";
import { fireDeadline, recordSignalEnd } from "./run.js";
import type { WorkerStatus } from "./status.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "endreason-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const st = (o: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id: "w1", label: "t", cwd: dir, provider: "p", state: "running", parentPid: 4242, parentComm: "claude", ...o }) as WorkerStatus;

describe("decideEndReason", () => {
  it("deadline: fireDeadline then a signal still reads deadline", () => {
    const s = st();
    fireDeadline(dir, s, join(dir, "ledger.log"), { deadlineAt: Date.now(), minutes: 1 });
    const end = recordSignalEnd(dir, s, "SIGTERM");
    expect(end.reason).toBe("deadline");
    expect(s.endReason).toBe("deadline");
  });

  it("pai-worker-kill: marker gives reason and by, is consumed, ledger has WORKER-KILL", () => {
    const ledger = join(dir, "ledger.log");
    requestKill(dir, ledger, "w1", "session-alpha");
    expect(JSON.parse(readFileSync(killMarkerPath(dir, "w1"), "utf8"))).toMatchObject({ by: "session-alpha", pid: process.pid });
    const s = st();
    const end = recordSignalEnd(dir, s, "SIGTERM");
    expect(end).toMatchObject({ reason: "pai-worker-kill", by: "session-alpha" });
    expect(s.endBy).toBe("session-alpha");
    expect(existsSync(killMarkerPath(dir, "w1"))).toBe(false);
    expect(readFileSync(ledger, "utf8")).toMatch(/WORKER-KILL id=w1 by=session-alpha/);
    expect(endLabel(s)).toBe("pai-worker-kill by session-alpha");
  });

  it("parent-gone: dead parent, no marker", () => {
    const end = decideEndReason({ logDir: dir, id: "w1", signal: "SIGHUP", parentPid: 4242, isAlive: () => false });
    expect(end.reason).toBe("parent-gone");
    expect(end.note).toContain("4242");
  });

  it("external-signal: live parent, no marker, names signal and parent command", () => {
    const end = decideEndReason({
      logDir: dir,
      id: "w1",
      signal: "SIGTERM",
      parentPid: 4242,
      parentComm: "claude",
      isAlive: () => true,
    });
    expect(end.reason).toBe("external-signal");
    expect(end.note).toContain("SIGTERM");
    expect(end.note).toContain("sender unknown");
    expect(end.note).toContain("(claude)");
  });

  it("no signal, no deadline: plain exit", () => {
    expect(decideEndReason({ logDir: dir, id: "w1" }).reason).toBe("exit");
  });

  it("callerDescription prefers the PAI session name", () => {
    expect(callerDescription({ PAI_SESSION_NAME: "n", CLAUDE_CODE_SESSION_ID: "x" })).toBe("n");
    expect(callerDescription({ CLAUDE_CODE_SESSION_ID: "x" })).toBe("claude-session:x");
  });
});
