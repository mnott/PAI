/** The pane belongs to the worker's process: it ends only when that process exited AND the worker ended cleanly. */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOwnedPane, runPaneExec, exitFilePath, recordPath } from "./pane-exec.js";
import { paneMayClose } from "./pane.js";
import { paneReapable } from "../daemon/daemon/scheduler.js";
import { parseLedger } from "./ledger.js";
import { saveStatus, loadStatus, nowStamp, type WorkerStatus } from "./status.js";
import { recordSystemWaiver } from "./pane-waiver.js";
import { statusLineOutput } from "./viewer.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-panelife-"));
  vi.stubEnv("PAI_HOME", join(dir, "home"));
  vi.stubEnv("PAI_WORKER_ALLOW_HIDDEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  pid: 99999999,
  label: "w",
  cwd: "/repo",
  term: "",
  provider: "prov",
  model: "m",
  state: "running",
  started: "2026-09-17 10:00:00",
  updated: "2026-09-17 10:00:30",
  turns: 1,
  tools: 1,
  last: "x",
  rc: null,
  secs: null,
  origin: "spawn",
} as WorkerStatus;

/** A pane-exec launch of worker `id`: the record exists from the pane's opening, the exit file when its process ended. */
function paneOf(id: string, ended: boolean): void {
  mkdirSync(join(dir, "home", "state", "pane-exec"), { recursive: true });
  writeFileSync(recordPath(id), JSON.stringify({ id, kind: "worker", caller: 1, startedMs: 1 }));
  if (ended) writeFileSync(exitFilePath(id), JSON.stringify({ id, code: 0, endedMs: 2 }));
}

describe("paneMayClose: process exited AND clean end", () => {
  it("simulation: pooled start, host reload, fresh restart under the same id, then done", () => {
    const id = "w-sim";
    paneOf(id, false); // pane opened and owned before the task is handed to a slot
    saveStatus(dir, { ...base, id, state: "running", pool: { slot: "s1" } } as WorkerStatus);
    expect(paneMayClose(dir, id)).toBe(false);
    // host reload: the slot dies, the run is lost; the pane's own process (the follow) lives on
    saveStatus(dir, { ...loadStatus(dir, id)!, state: "lost", rc: null, last: "pool host reloaded" });
    expect(paneMayClose(dir, id)).toBe(false); // the pane's own process (the follow) lives on
    // fresh restart under the same id reuses the pane
    saveStatus(dir, { ...loadStatus(dir, id)!, state: "running", last: "restarted" });
    expect(paneMayClose(dir, id)).toBe(false);
    // clean end, but the pane's process has not exited yet
    saveStatus(dir, { ...loadStatus(dir, id)!, state: "done", rc: 0 });
    expect(paneMayClose(dir, id)).toBe(false);
    // now the process exited
    paneOf(id, true);
    expect(paneMayClose(dir, id)).toBe(true);
  });

  it("a failed worker's pane may close once its process exited", () => {
    paneOf("w-f", true);
    for (const state of ["failed", "killed", "lost"] as const) {
      saveStatus(dir, { ...base, id: "w-f", state, rc: 1 });
      expect(paneMayClose(dir, "w-f")).toBe(true);
    }
  });

  it("a failed pane is reaped after the same grace as a clean one; a running one never", () => {
    const t = Date.parse("2020-01-01T00:10:00");
    const at = (state: string, updated: string) => ({ ...base, id: "w", state, updated }) as WorkerStatus;
    expect(paneReapable(at("done", "2020-01-01 00:09:30"), t)).toBe(true);
    expect(paneReapable(at("failed", "2020-01-01 00:09:30"), t)).toBe(true);
    expect(paneReapable(at("failed", "2020-01-01 00:09:59"), t)).toBe(false);
    expect(paneReapable(at("running", "2020-01-01 00:00:00"), t)).toBe(false);
  });
});

describe("the pane wrapper lingers the same, then closes the pane of a clean and of a failed process", () => {
  const run = async (code: number, linger: number): Promise<{ closedAfter: () => boolean; out: string; waitClosed: () => Promise<void> }> => {
    const id = `w-linger-${code}-${linger}`;
    let closed = false;
    let out = "";
    const pane = await openOwnedPane({
      id,
      kind: "worker",
      open: async () => {
        void runPaneExec(id, {
          out: (s) => void (out += String(s)),
          err: (s) => void (out += String(s)),
          closePane: async () => void (closed = true),
          linger,
          proc: new EventEmitter() as NodeJS.Process,
          killGraceMs: 300,
        });
        return "fake pane";
      },
      helloMs: 5000,
    });
    const proc = await pane.start({ argv: ["sh", "-c", `exit ${code}`], render: "plain", stdin: "ignore" });
    await new Promise((r) => proc.on("close", r));
    return { closedAfter: () => closed, out, waitClosed: () => new Promise((r) => { const t = setInterval(() => closed && (clearInterval(t), r()), 20); }) };
  };

  it("exit 0 closes the pane after the clean linger", async () => {
    const r = await run(0, 0.3);
    await new Promise((x) => setTimeout(x, 100));
    expect(r.closedAfter()).toBe(false);
    await r.waitClosed();
    expect(r.closedAfter()).toBe(true);
  });

  it("a non-zero exit closes the pane too, after the same linger, with the error on screen", async () => {
    const r = await run(3, 0.4);
    await new Promise((x) => setTimeout(x, 150));
    expect(r.closedAfter()).toBe(false); // still lingering
    expect(r.out).toContain("[exit 3");
    expect(r.out).toContain("closes in");
    await r.waitClosed();
    expect(r.closedAfter()).toBe(true);
    expect(existsSync(exitFilePath("w-linger-3-0.4"))).toBe(true);
  });
});

describe("system waiver", () => {
  it("is ledgered PANE-WAIVED kind=system reason=<job>", () => {
    const ledger = join(dir, "ledger");
    recordSystemWaiver(ledger, "keepalive", "hb-1");
    const l = parseLedger(readFileSync(ledger, "utf8")).find((x) => x.event === "PANE-WAIVED");
    expect(l?.fields).toMatchObject({ id: "hb-1", kind: "system", reason: "keepalive" });
  });
});

describe("attribution: host terminal first, Claude session second", () => {
  const uuid = "1F355502-AAAA-BBBB-CCCC-DDDDEEEEFFFF";
  const term = `w5t0p0:${uuid}`;
  const now = new Date();

  it("workers started from my terminal stay mine after the Claude session id changed (fork/resume)", () => {
    saveStatus(dir, { ...base, pid: process.pid, started: nowStamp(), updated: nowStamp(), id: "20260917-100000-1", term, spawnerSession: "old-session" });
    saveStatus(dir, { ...base, pid: process.pid, started: nowStamp(), updated: nowStamp(), id: "20260917-100001-2", term, session: { id: uuid, name: "me" }, spawnerSession: "older-session" });
    const line = statusLineOutput(dir, term, "/x", "new-session", now);
    expect(line).toMatch(/^▶2/);
    expect(line).not.toContain("elsewhere");
  });

  it("a worker spawned by a session with no iTerm id of its own counts as mine, another session's is elsewhere", () => {
    saveStatus(dir, { ...base, pid: process.pid, started: nowStamp(), updated: nowStamp(), id: "20260917-100003-4", term: "", spawnerSession: "bg-session" });
    saveStatus(dir, { ...base, pid: process.pid, started: nowStamp(), updated: nowStamp(), id: "20260917-100004-5", term: "", spawnerSession: "other-session" });
    const line = statusLineOutput(dir, "w1t0p0:11111111-0000-0000-0000-000000000000", "/x", "bg-session", now);
    expect(line).toMatch(/^▶1/);
    expect(line).toContain("(+1 elsewhere)");
  });

  it("a worker of another terminal is elsewhere even with the same Claude session id", () => {
    saveStatus(dir, { ...base, pid: process.pid, started: nowStamp(), updated: nowStamp(), id: "20260917-100002-3", term: "w9t0p0:99999999-0000-0000-0000-000000000000", spawnerSession: "new-session" });
    expect(statusLineOutput(dir, term, "/x", "new-session", now)).toContain("(+1 elsewhere)");
  });
});
