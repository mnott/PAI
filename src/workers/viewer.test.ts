/**
 * viewer.test.ts — the follow loop must end when the worker ends.
 *
 * Guarded bug (2026-11-24): a pane opened with `pai worker pane <id>` kept
 * running `pai worker follow <id>` forever after the worker was killed
 * (state "killed", rc 143). The interactive follow (chat mode, wired stdin)
 * never returned `done` after the worker's end state, so the pane never
 * closed. The fix: once the target is finished and its status is terminal
 * with no owned pid, the loop exits — interactive or not.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { followWorkers, workerEnded } from "./viewer.js";
import { reconcileStatuses, saveStatus, type WorkerStatus } from "./status.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join("/tmp", "viewer-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A status file for a worker that is over: killed, pid gone. */
function writeKilled(id: string): WorkerStatus {
  const st: WorkerStatus = {
    id,
    label: "killed-worker",
    cwd: dir,
    provider: "test",
    state: "killed",
    rc: 143,
    last: "killed by signal SIGTERM (parent-gone by external)",
    term: "", model: "", turns: 0, tools: 0, secs: 5,
    pid: 999999, // no such process
    started: new Date().toISOString().replace("T", " "),
    updated: new Date().toISOString().replace("T", " "),
  };
  saveStatus(dir, st);
  return st;
}

/** A fake stdout that records writes and is never a TTY. */
function fakeOut(): { chunks: string[]; write(s: string): boolean } {
  const chunks: string[] = [];
  return {
    chunks,
    write(s: string) {
      chunks.push(s);
      return true;
    },
  };
}

describe("workerEnded", () => {
  it("counts every end state as ended", () => {
    // every terminal state the WorkerStatus union carries is ended
    for (const state of ["done", "failed", "killed", "deepfrozen", "review", "lost"] as const) {
      expect(workerEnded(false, state)).toBe(true);
    }
    expect(workerEnded(false, "running")).toBe(false);
    expect(workerEnded(false, "queued")).toBe(false);
    expect(workerEnded(false, undefined)).toBe(false);
  });
});

describe("followWorkers exits on a killed worker", () => {
  it("ends the loop when the status flips to killed (interactive stdin)", async () => {
    const id = "20261124-155733-00001";
    writeKilled(id);
    const out = fakeOut();
    // a wired, never-closing stdin: the old code kept the pane open on this
    const stdin = new Readable({ read() {} });
    Object.defineProperty(stdin, "isTTY", { value: true });
    const done = await followWorkers(dir, id, false, 0, { PAI_WORKER: "1" }, false, {
      stdout: out as never,
      stdin,
    });
    expect(done).toBeUndefined(); // returned, not hung
    const text = out.chunks.join("");
    expect(text).toContain("killed");
    expect(text).toContain("ended killed rc=143");
  });

  it("ends the loop when the status is a stale running with a dead pid", async () => {
    const id = "20261124-155733-00002";
    const st: WorkerStatus = {
      id,
      label: "ghost-worker",
      cwd: dir,
      provider: "test",
      state: "running",
      rc: null,
      last: "",
      term: "", model: "", turns: 0, tools: 0, secs: null,
      pid: 999999, // no such process
      started: new Date(Date.now() - 300_000).toISOString().replace("T", " "),
      updated: new Date(Date.now() - 300_000).toISOString().replace("T", " "),
      procStart: Date.now() - 300_000, // recorded start: a live pid at this time would be owned
    };
    saveStatus(dir, st);
    // the stale status is reconciled to "lost" before follow reads it (LOST_GRACE_MS)
    reconcileStatuses(dir, new Date(), 0);
    const out = fakeOut();
    // no wired stdin here (non-TTY): a wired one would keep the process alive after follow returns
    await followWorkers(dir, id, false, 0, { PAI_WORKER: "1" }, false, { stdout: out as never });
    const text = out.chunks.join("");
    // reconcileStatuses (LOST_GRACE_MS) turns a dead-pid "running" into "lost";
    // the follow must end on that terminal state either way
    expect(text).toMatch(/ended (running|lost) rc=/);
  });

  it("revives on a same-id restart instead of exiting", async () => {
    const id = "20261124-155733-00003";
    writeKilled(id);
    // flip back to running with a live pid (our own): the follow must keep going
    const st: WorkerStatus = {
      id,
      label: "restarted-worker",
      cwd: dir,
      provider: "test",
      state: "running",
      rc: null,
      last: "",
      term: "", model: "", turns: 0, tools: 0, secs: null,
      pid: process.pid,
      started: new Date().toISOString().replace("T", " "),
      updated: new Date().toISOString().replace("T", " "),
    };
    saveStatus(dir, st);
    const out = fakeOut();
    const p = followWorkers(dir, id, false, 0, { PAI_WORKER: "1" }, false, { stdout: out as never });
    // it must NOT return within 1.5 s: the run revived
    const raced = await Promise.race([p.then(() => "returned"), new Promise((r) => setTimeout(() => r("still-following"), 1500))]);
    expect(raced).toBe("still-following");
  });
});
