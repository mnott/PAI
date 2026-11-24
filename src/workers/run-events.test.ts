/**
 * run-events.test.ts — delivery failure handling for run reports.
 *
 * A report to a session that is not running Claude must be parked in that
 * session's mailbox exactly once and logged once, never retried; a transient
 * failure (hub unreachable, timeout) is retried at most 3 times.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aibrokerMessenger, resetUndeliverable, sweepRuns, isUndeliverableError, parkInMailbox, eventLine, type Messenger, type RunOrigin } from "./run-events.js";

const NOT_RUNNING = 'Error: Session "FE2552A8" is not running Claude — its terminal is at a shell prompt, so nothing was sent (a shell would execute the message rather than read it). An ended session leaves its tab behind; close it, or target a session that is running.';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-run-events-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A dead run registered in the sweep registry. */
function deadRun(logDir: string, id: string, origin: RunOrigin): void {
  const runsDir = join(logDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `${id}.json`), JSON.stringify({ id, kind: "plan", pid: 999999, argv: [], cwd: logDir, origin, started: new Date().toISOString(), output: join(runsDir, `${id}.out`) }), "utf8");
}

describe("isUndeliverableError", () => {
  it("matches not-running-Claude and gone-session errors", () => {
    expect(isUndeliverableError(NOT_RUNNING)).toBe(true);
    expect(isUndeliverableError("Session not found")).toBe(true);
    expect(isUndeliverableError("AIBroker not running (socket not found).")).toBe(true);
    expect(isUndeliverableError("AIBroker IPC connection closed before response.")).toBe(true);
  });
  it("does not match transient errors", () => {
    expect(isUndeliverableError("AIBroker IPC call timed out.")).toBe(false);
    expect(isUndeliverableError("ECONNRESET")).toBe(false);
    expect(isUndeliverableError("")).toBe(false);
  });
});

describe("eventLine", () => {
  it("flattens tabs and carriage returns in values so the line stays one line", () => {
    const line = eventLine("abc", "R", { z: "a\tb\r\nc|d" }, "sentence");
    expect(line).toBe("S i=abc z=R | z=a b  c d — sentence");
    expect(line).not.toMatch(/[\t\r\n]/);
  });
});

describe("parkInMailbox", () => {
  it("deposits once and logs one line", async () => {
    const logs: string[] = [];
    const deposits: string[] = [];
    const ok = await parkInMailbox("FE2552A8", "hello", (s) => logs.push(s), async (t, x) => {
      deposits.push(`${t}:${x}`);
      return { ok: true };
    });
    expect(ok).toBe(true);
    expect(deposits).toEqual(["FE2552A8:hello"]);
    expect(logs).toEqual(["run report for FE2552A8 parked in mailbox of FE2552A8: not running Claude"]);
    expect(logs).toEqual(["run report for FE2552A8 parked in mailbox of FE2552A8: not running Claude"]);
  });
});

describe("aibrokerMessenger.toSession", () => {
  beforeEach(() => resetUndeliverable());
  it("not running Claude: exactly one mailbox deposit, one log line, no typed retry", async () => {
    const logs: string[] = [];
    const typed: string[] = [];
    const deposits: string[] = [];
    const msg = aibrokerMessenger(dir, (s) => logs.push(s), async () => "", async (t, x) => {
      typed.push(`${t}:${x}`);
      return { ok: false, error: NOT_RUNNING };
    }, async (t, x) => {
      deposits.push(`${t}:${x}`);
      return { ok: true };
    });
    const origin: RunOrigin = { iterm: "FE2552A8" };
    const sent = await msg.toSession(origin, "report one");
    expect(sent).toBe(false);
    // the typed send happened once; the report was parked once, not retried
    expect(typed).toHaveLength(1);
    expect(deposits).toEqual(["FE2552A8:report one"]); // parked once via the injected deposit
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("parked in mailbox of FE2552A8");
    expect(msg.lastError).toContain("not running Claude");
  });

  it("transient error: reported as a failure, not parked", async () => {
    const logs: string[] = [];
    const msg = aibrokerMessenger(dir, (s) => logs.push(s), async () => "", async () => ({ ok: false, error: "AIBroker IPC call timed out." }));
    const sent = await msg.toSession({ iterm: "FE2552A8" }, "report");
    expect(sent).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("run report not delivered to the session");
    expect(logs[0]).not.toContain("parked");
  });
});

describe("aibrokerMessenger undeliverable memory", () => {
  beforeEach(() => resetUndeliverable());
  it("100 calls to a dead target: one send, one deposit, one log line; others unaffected; retries after the window", async () => {
    const logs: string[] = [];
    const typed: string[] = [];
    const deposits: string[] = [];
    let t = 1_000_000;
    const msg = aibrokerMessenger(
      dir,
      (s) => logs.push(s),
      async () => "",
      async (target, x) => {
        typed.push(`${target}:${x}`);
        return target === "DEAD" ? { ok: false, error: NOT_RUNNING } : { ok: true };
      },
      async (target, x) => {
        deposits.push(`${target}:${x}`);
        return { ok: false, error: NOT_RUNNING };
      },
      undefined,
      () => t,
    );
    for (let i = 0; i < 100; i++) expect(await msg.toSession({ iterm: "DEAD" }, `r${i}`)).toBe(false);
    expect(typed).toHaveLength(1);
    expect(deposits).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(await msg.toSession({ iterm: "LIVE" }, "x")).toBe(true);
    expect(typed).toHaveLength(2);
    t += 31 * 60_000;
    await msg.toSession({ iterm: "DEAD" }, "again");
    expect(typed).toHaveLength(3);
    expect(deposits).toHaveLength(2);
  });
});

describe("sweepRuns", () => {
  /** A messenger whose send fails with `err` on every call; counts calls. */
  function fakeHub(err: string | null): { msg: Messenger; calls: number; logs: string[] } {
    const state = { calls: 0, logs: [] as string[] };
    const msg: Messenger = {
      lastError: undefined,
      async toSession(origin, text) {
        state.calls++;
        if (err) {
          msg.lastError = err;
          if (isUndeliverableError(err)) state.logs.push(`run report for ${origin.iterm} parked in mailbox of ${origin.iterm}: not running Claude`);
          else state.logs.push(`run report not delivered to the session: ${origin.iterm}: ${err}`);
          return false;
        }
        return true;
      },
      async toPailot() {
        return true;
      },
    };
    return { msg, get calls() { return state.calls; }, logs: state.logs };
  }

  it("undeliverable report: one deposit, one log line, no further attempts across ticks", async () => {
    const origin: RunOrigin = { iterm: "FE2552A8" };
    deadRun(dir, "plan-dead-1", origin);
    const hub = fakeHub(NOT_RUNNING);
    const told = await sweepRuns(dir, hub.msg, () => false);
    expect(told).toEqual([]);
    expect(hub.calls).toBe(1);
    expect(hub.logs).toHaveLength(1);
    expect(hub.logs[0]).toContain("parked in mailbox of FE2552A8");
    // parked marker written; later ticks must not touch it again
    expect(existsSync(join(dir, "runs", "plan-dead-1.json.parked"))).toBe(true);
    await sweepRuns(dir, hub.msg, () => false);
    expect(hub.calls).toBe(1);
    expect(hub.logs).toHaveLength(1);
    // the parked entry is dropped from the registry on the next tick
    expect(existsSync(join(dir, "runs", "plan-dead-1.json.parked"))).toBe(false);
    expect(existsSync(join(dir, "runs", "plan-dead-1.json"))).toBe(false);
    await sweepRuns(dir, hub.msg, () => false);
    expect(hub.calls).toBe(1);
  });

  it("transient error: retried at most 3 times, then dropped", async () => {
    const origin: RunOrigin = { iterm: "FE2552A8" };
    deadRun(dir, "plan-dead-2", origin);
    const hub = fakeHub("AIBroker IPC call timed out.");
    await sweepRuns(dir, hub.msg, () => false);
    expect(hub.calls).toBe(1);
    await sweepRuns(dir, hub.msg, () => false);
    expect(hub.calls).toBe(2);
    await sweepRuns(dir, hub.msg, () => false);
    expect(hub.calls).toBe(3);
    // after the 3rd attempt the report is parked; no more attempts ever
    expect(existsSync(join(dir, "runs", "plan-dead-2.json.retry"))).toBe(false);
    expect(existsSync(join(dir, "runs", "plan-dead-2.json.parked"))).toBe(true);
    await sweepRuns(dir, hub.msg, () => false);
    expect(hub.calls).toBe(3);
    expect(existsSync(join(dir, "runs", "plan-dead-2.json.parked"))).toBe(false);
    expect(existsSync(join(dir, "runs", "plan-dead-2.json"))).toBe(false);
  });

  it("delivered report: marked done, told once, never again", async () => {
    const origin: RunOrigin = { iterm: "FE2552A8" };
    deadRun(dir, "plan-dead-3", origin);
    const hub = fakeHub(null);
    const told = await sweepRuns(dir, hub.msg, () => false);
    expect(told).toEqual(["plan-dead-3"]);
    expect(hub.calls).toBe(1);
    await sweepRuns(dir, hub.msg, () => false);
    expect(hub.calls).toBe(1);
  });

  it("drains a backlog of dead sessions without looping", async () => {
    for (let i = 0; i < 6; i++) deadRun(dir, `plan-dead-${i}`, { iterm: `S${i}` });
    const hub = fakeHub(NOT_RUNNING);
    await sweepRuns(dir, hub.msg, () => false);
    expect(hub.calls).toBe(6);
    expect(hub.logs).toHaveLength(6);
    await sweepRuns(dir, hub.msg, () => false);
    expect(hub.calls).toBe(6); // backlog drained, no loop
  });
});
