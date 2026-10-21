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
    expect(paneMayClose(dir, id)).toBe(false); // failure stays on screen
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

  it("a failed worker's pane stays even after its process exited", () => {
    paneOf("w-f", true);
    for (const state of ["failed", "killed", "lost"] as const) {
      saveStatus(dir, { ...base, id: "w-f", state, rc: 1 });
      expect(paneMayClose(dir, "w-f")).toBe(false);
    }
  });

  it("the daemon reaper never reaps a failed pane", () => {
    expect(paneReapable({ ...base, id: "w", state: "failed", updated: "2020-01-01 00:00:00" } as WorkerStatus)).toBe(false);
    expect(paneReapable({ ...base, id: "w", state: "done", updated: "2020-01-01 00:00:00" } as WorkerStatus)).toBe(true);
  });
});

describe("the pane wrapper holds a failed process's pane", () => {
  const run = async (code: number, hold: () => Promise<void>): Promise<{ closed: boolean; out: string }> => {
    const id = `w-hold-${code}`;
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
          hold,
          proc: new EventEmitter() as NodeJS.Process,
          killGraceMs: 300,
        });
        return "fake pane";
      },
      helloMs: 5000,
    });
    const proc = await pane.start({ argv: ["sh", "-c", `exit ${code}`], render: "plain", stdin: "ignore" });
    await new Promise((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 200));
    return { closed, out };
  };

  it("exit 0 closes the pane", async () => {
    const r = await run(0, async () => new Promise<void>(() => undefined));
    expect(r.closed).toBe(true);
  });

  it("a non-zero exit leaves the pane open with the failure on screen", async () => {
    const r = await run(3, async () => new Promise<void>(() => undefined));
    expect(r.closed).toBe(false);
    expect(r.out).toContain("[exit 3");
    expect(r.out).toContain("pane stays open");
    expect(existsSync(exitFilePath("w-hold-3"))).toBe(true);
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

  it("a worker of another terminal is elsewhere even with the same Claude session id", () => {
    saveStatus(dir, { ...base, pid: process.pid, started: nowStamp(), updated: nowStamp(), id: "20260917-100002-3", term: "w9t0p0:99999999-0000-0000-0000-000000000000", spawnerSession: "new-session" });
    expect(statusLineOutput(dir, term, "/x", "new-session", now)).toContain("(+1 elsewhere)");
  });
});
