/**
 * Tests for the operator channel — the per-worker Unix socket `say` uses. A
 * real socket pair in a temp dir; no claude, no osascript, no terminal.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { createOperatorServer, operatorSocketPath, sayToWorker } from "./operator.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-operator-test-"));
let server: Server | null = null;

function runningWorker(id: string, state: WorkerStatus["state"] = "running", pid = process.pid): WorkerStatus {
  const s: WorkerStatus = {
    id,
    pid,
    label: "test worker",
    cwd: dir,
    term: "",
    provider: "testprov",
    model: "test-1",
    state,
    started: "2026-09-17 10:00:00",
    updated: "2026-09-17 10:00:00",
    turns: 0,
    tools: 0,
    last: "",
    rc: null,
    secs: null,
  };
  saveStatus(dir, s);
  return s;
}

afterEach(() => {
  server?.close();
  server = null;
});

describe("createOperatorServer + sayToWorker", () => {
  it("forwards a line to onLine and answers ok", async () => {
    const id = "20260917-100000-111";
    runningWorker(id);
    const got: string[] = [];
    server = createOperatorServer(dir, id, (t) => got.push(t));

    await expect(sayToWorker(dir, id, "check the build")).resolves.toBe("ok");
    expect(got).toEqual(["check the build"]);
  });

  it("newlines inside the text are flattened (one message, one line)", async () => {
    const id = "20260917-100000-222";
    runningWorker(id);
    const got: string[] = [];
    server = createOperatorServer(dir, id, (t) => got.push(t));

    await sayToWorker(dir, id, "line one\nline two");
    expect(got).toEqual(["line one line two"]);
  });

  it("handles several messages and partial (split) writes", async () => {
    const id = "20260917-100000-333";
    runningWorker(id);
    const got: string[] = [];
    server = createOperatorServer(dir, id, (t) => got.push(t));

    await sayToWorker(dir, id, "first");
    await sayToWorker(dir, id, "second");
    expect(got).toEqual(["first", "second"]);
  });

  it("refuses with a clear error when the worker is done (suggests resume)", async () => {
    const id = "20260917-100000-444";
    runningWorker(id, "done");
    server = createOperatorServer(dir, id, () => {});
    await expect(sayToWorker(dir, id, "hi")).rejects.toThrow(/not running.*resume/s);
  });

  it("refuses when the pid is dead", async () => {
    const id = "20260917-100000-555";
    runningWorker(id, "running", 999999999);
    await expect(sayToWorker(dir, id, "hi")).rejects.toThrow(/not running/);
  });

  it("refuses when there is no such worker", async () => {
    await expect(sayToWorker(dir, "99999999-000000-1", "hi")).rejects.toThrow(/no worker named/);
  });

  it("unlinks the socket file when the server closes", async () => {
    const id = "20260917-100000-666";
    runningWorker(id);
    server = createOperatorServer(dir, id, () => {});
    const path = operatorSocketPath(dir, id);
    expect(existsSync(path)).toBe(true);
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    expect(existsSync(path)).toBe(false);
  });
});

describe("socket hygiene", () => {
  it("replaces a stale socket file left by a crashed run", () => {
    const id = "20260917-100000-777";
    runningWorker(id);
    const path = operatorSocketPath(dir, id);
    writeFileSync(path, "stale", "utf8"); // not a listening socket
    const got: string[] = [];
    server = createOperatorServer(dir, id, (t) => got.push(t));
    expect(existsSync(path)).toBe(true); // bound again
    return sayToWorker(dir, id, "after restart").then(() => {
      expect(got).toEqual(["after restart"]);
    });
  });
});
