import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queueRows, writeTicket } from "./capacity.js";
import { applyPriority } from "./preempt.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prio-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const st = (id: string): WorkerStatus =>
  ({ id, pid: process.pid, label: "l", cwd: "/", term: "", provider: "fakeA", model: "m", state: "queued", started: "", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null, promptFile: "/x" }) as WorkerStatus;

describe("queue priority persistence", () => {
  it("a level set on a queued run survives a ticket rewritten from the start options (daemon restart)", () => {
    saveStatus(dir, st("w1"));
    mkdirSync(join(dir, "queue", "fakeA"), { recursive: true });
    const ticket = join(dir, "queue", "fakeA", "w1");
    writeTicket(ticket, `${process.pid} @1`);
    applyPriority(dir, "w1", "high");
    expect(loadStatus(dir, "w1")!.priority).toBe("high");
    // a restart rebuilds the ticket as normal: the status file still decides
    writeTicket(ticket, `${process.pid} @1`);
    const row = queueRows(dir, {}, () => true).find((r) => r.id === "w1")!;
    expect(row.priority).toBe("high");
  });
});
