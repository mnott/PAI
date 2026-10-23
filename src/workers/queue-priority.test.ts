/**
 * Queue priority (fairOrder tiers, ticket marks), pid ownership of a run that queued before admission
 * (fake process table), and the pane's in-place queue line.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ellipsize, fairOrder, liveQueue, queueLineWriter, queuedPaneLine, queueRows, capacityGate, type QueuedFile } from "./capacity.js";
import { makeOwnsPid, nowStamp, saveStatus, type ProcTable, type WorkerStatus } from "./status.js";
import { killTree } from "./kill-tree.js";
import { queuePriorityOf } from "./run/gate.js";

const e = (id: string, priority?: "high" | "normal" | "low", since = 1000) => ({ id, pid: 1, front: false, since, ...(priority ? { priority } : {}) });

describe("queue priority", () => {
  const one = () => "S";
  it("admits high before normal before low, FIFO within a priority", () => {
    const order = fairOrder({ entries: [e("a", "low", 1), e("b", undefined, 2), e("c", "high", 3), e("d", "normal", 4), e("f", "high", 5)], sessionOf: one, running: [], now: 10_000 });
    expect(order.map((x) => x.id)).toEqual(["c", "f", "b", "d", "a"]);
  });

  it("a different session at high jumps three older normal tickets of another session", () => {
    const sess = (id: string) => (id.startsWith("pai") ? "PAI" : "Jobs");
    const order = fairOrder({ entries: [e("pai1", undefined, 1), e("pai2", undefined, 2), e("pai3", undefined, 3), e("jobs1", "high", 9)], sessionOf: sess, running: ["PAI", "PAI", "PAI"], now: 10_000 });
    expect(order[0]!.id).toBe("jobs1");
  });

  it("--now (front) still beats priority", () => {
    const order = fairOrder({ entries: [e("h", "high", 1), { ...e("n", "low", 2), front: true }], sessionOf: one, running: [], now: 10_000 });
    expect(order.map((x) => x.id)).toEqual(["n", "h"]);
  });

  it("aging promotes within a priority only", () => {
    const order = fairOrder({ entries: [e("old-normal", undefined, 0), e("new-high", "high", 9_999_000)], sessionOf: one, running: [], now: 10_000_000, agingMs: 900_000 });
    expect(order.map((x) => x.id)).toEqual(["new-high", "old-normal"]);
  });

  it("tickets written by the gate carry the priority through liveQueue and queueRows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-prio-"));
    let t = 0;
    let seen: string[] = [];
    let rows: string[] = [];
    const gate = (id: string, tier?: "high" | "low") =>
      capacityGate({
        logDir: dir, self: { id, provider: "p", pid: 4242 }, cap: 1, config: {}, tier,
        now: () => (t += 10), isAlive: () => true,
        sleep: async () => {
          // w3 reads the queue once every gate has written its ticket; the others leave after it
          await new Promise((r) => setTimeout(r, id === "w3" ? 5 : 40));
          if (id === "w3") {
            seen = liveQueue(dir, "p", () => true, []);
            rows = queueRows(dir, {}, () => true, []).map((r) => `${r.id}:${r.priority ?? "normal"}`);
          }
          throw new Error("stop");
        },
        load: () => [{ id: "holder", pid: 1, provider: "p", state: "running", started: nowStamp(), label: "h", sessionKey: "S" } as WorkerStatus],
      }).catch(() => undefined);
    await Promise.all([gate("w1"), gate("w2", "high"), gate("w3", "low")]);
    expect(seen).toEqual(["w2", "w1", "w3"]);
    expect(rows).toEqual(["w2:high", "w1:normal", "w3:low"]);
  });

  it("the flag beats the session entry, which beats normal", () => {
    const cfg = { priority: { sessions: { Jobs: "high" as const } } };
    expect(queuePriorityOf(undefined, { sessionKey: "Jobs" }, cfg)).toBe("high");
    expect(queuePriorityOf("low", { sessionKey: "Jobs" }, cfg)).toBe("low");
    expect(queuePriorityOf(undefined, { sessionKey: "PAI" }, cfg)).toBe("normal");
    expect(queuePriorityOf(undefined, {}, {})).toBe("normal");
  });
});

describe("pid ownership of a run that queued before admission (fake process table)", () => {
  const MIN = 60_000;
  const table = (cmd: string, startMs: number): ProcTable => ({ alive: () => true, startMs: () => startMs, command: () => cmd, parentPid: () => undefined });
  const admitted = Date.parse("2026-10-23T16:25:53");
  const status = (over: Partial<WorkerStatus> = {}): WorkerStatus =>
    ({ id: "20261023-161512-77777", pid: 86319, label: "cockpit turn view", cwd: "/tmp", term: "", provider: "gyro-m", model: "m", state: "running", started: "2026-10-23 16:25:53", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null, ...over }) as WorkerStatus;

  it("owns the pid when the command line names the worker, whatever the admission time", () => {
    const owns = makeOwnsPid(table("node pai worker run --label cockpit turn view --spec x", admitted - 10 * MIN));
    expect(owns(status())).toBe(true);
  });

  it("owns the pid when procStart (spawn time) matches", () => {
    const owns = makeOwnsPid(table("node other", admitted - 10 * MIN));
    expect(owns(status({ procStart: admitted - 10 * MIN }))).toBe(true);
  });

  it("does not own a reused pid: other start time and unrelated command", () => {
    const owns = makeOwnsPid(table("/usr/bin/vim notes.txt", admitted - 3 * 3600_000));
    expect(owns(status())).toBe(false);
  });

  it("killTree signals a worker that waited in the queue first, and leaves a reused pid alone", async () => {
    for (const [cmd, expected] of [["node pai worker run --label cockpit turn view", [86319]], ["/usr/bin/vim", []]] as const) {
      const dir = mkdtempSync(join(tmpdir(), "pai-kill-q-"));
      saveStatus(dir, status());
      const signalled: number[] = [];
      const lines = await killTree(dir, status().id, {
        deps: { owns: makeOwnsPid(table(cmd, admitted - 10 * MIN)) as never, isAlive: () => false, request: () => undefined, graceMs: 0, signal: (pid) => void signalled.push(pid), waitTerminal: async () => null },
      });
      expect(signalled).toEqual(expected);
      if (!expected.length) expect(lines[0]).toContain("not this worker any more");
    }
  });
});

describe("queue line writer", () => {
  const q = (over: Partial<QueuedFile> = {}): QueuedFile => ({ provider: "gyro-m", position: 2, queued: 3, elapsedSec: 33, behind: "fix MCP server breaking on rebuild", ...over });

  it("TTY: same state, new elapsed time -> redraw in place with \\r, no newline", () => {
    const out: string[] = [];
    const w = queueLineWriter({ write: (s) => out.push(s), tty: true, columns: () => 200 });
    w.show(q());
    w.show(q({ elapsedSec: 36 }));
    w.show(q({ elapsedSec: 36 }));
    expect(out).toHaveLength(2);
    for (const s of out) {
      expect(s.startsWith("\r\x1b[K")).toBe(true);
      expect(s).not.toContain("\n");
    }
  });

  it("TTY: a new position starts a new line", () => {
    const out: string[] = [];
    const w = queueLineWriter({ write: (s) => out.push(s), tty: true, columns: () => 200 });
    w.show(q());
    w.show(q({ position: 1 }));
    expect(out[1]!.startsWith("\n\r\x1b[K")).toBe(true);
  });

  it("non-TTY: a line only on change of position or run ahead", () => {
    const out: string[] = [];
    const w = queueLineWriter({ write: (s) => out.push(s), tty: false });
    w.show(q());
    w.show(q({ elapsedSec: 90 }));
    expect(out).toHaveLength(1);
    w.show(q({ behind: "other" }));
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.endsWith("\n") && !s.includes("\r"))).toBe(true);
  });

  it("cuts to the width at a word boundary with an ellipsis", () => {
    expect(ellipsize("queued on gyro-m · position 2 of 3", 20)).toBe("queued on gyro-m ·…");
    expect(ellipsize("short", 20)).toBe("short");
    expect(ellipsize("abcdefghijklmnop", 8)).toBe("abcdefg…");
    const out: string[] = [];
    queueLineWriter({ write: (s) => out.push(s), tty: true, columns: () => 30 }).show(q());
    expect(out[0]!.slice(4).length).toBeLessThanOrEqual(29);
    expect(out[0]).toContain("…");
  });

  it("the pane line names a non-normal priority", () => {
    expect(queuedPaneLine(q({ priority: "high" }))).toContain("high priority");
    expect(queuedPaneLine(q({ priority: "normal" }))).not.toContain("priority");
  });
});
