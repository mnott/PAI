/**
 * Tests for handoffs: payload validation, the append-only inbox, delivery
 * (say only to a running, alive parent) and sending from inside a worker.
 * Status files and inboxes live in a tmp dir; the say path is a mock.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHandoff,
  deliverHandoff,
  handoffFromInside,
  handoffMessage,
  inboxPath,
  isHandoffKind,
  isHandoffMessage,
  parseHandoff,
  readInbox,
} from "./handoff.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-handoff-test-"));

function status(id: string, over: Partial<WorkerStatus> = {}): WorkerStatus {
  const s: WorkerStatus = {
    id,
    pid: process.pid,
    label: id,
    cwd: dir,
    term: "",
    provider: "testprov",
    model: "test-1",
    state: "running",
    started: "2026-09-17 10:00:00",
    updated: "2026-09-17 10:00:00",
    turns: 0,
    tools: 0,
    last: "",
    rc: null,
    secs: null,
    ...over,
  };
  saveStatus(dir, s);
  return s;
}

describe("isHandoffKind", () => {
  it("accepts the four kinds and nothing else", () => {
    for (const k of ["proposal", "result", "question", "blocker"]) {
      expect(isHandoffKind(k)).toBe(true);
    }
    expect(isHandoffKind("suggestion")).toBe(false);
    expect(isHandoffKind(7)).toBe(false);
  });
});

describe("parseHandoff", () => {
  it("parses a full payload", () => {
    const h = parseHandoff({ from: "c", to: "p", kind: "proposal", text: "do X", data: { a: 1 } });
    expect(h).toEqual({ from: "c", to: "p", kind: "proposal", text: "do X", data: { a: 1 } });
  });
  it("presets from/to when the payload omits them (the CLI fills them)", () => {
    expect(parseHandoff({ kind: "question", text: "why" }, { from: "me", to: "parent" })).toEqual({
      from: "me",
      to: "parent",
      kind: "question",
      text: "why",
    });
  });
  it("rejects a bad kind, empty text and non-object payloads", () => {
    expect(() => parseHandoff({ from: "c", to: "p", kind: "memo", text: "x" })).toThrow(/kind.*proposal/);
    expect(() => parseHandoff({ from: "c", to: "p", kind: "result", text: "  " })).toThrow(/non-empty "text"/);
    expect(() => parseHandoff("hello", { from: "c", to: "p" })).toThrow(/JSON object/);
    expect(() => parseHandoff({ kind: "result", text: "x" })).toThrow(/needs "from"/);
    expect(() => parseHandoff({ from: "c", kind: "result", text: "x" })).toThrow(/needs "to"/);
  });
});

describe("appendHandoff / readInbox", () => {
  it("appends stamped lines to <parent>.inbox.jsonl, oldest first", () => {
    appendHandoff(dir, { from: "c1", to: "p", kind: "proposal", text: "one" }, new Date("2026-09-17T10:00:00Z"));
    appendHandoff(dir, { from: "c2", to: "p", kind: "question", text: "two" }, new Date("2026-09-17T10:01:00Z"));
    const raw = readFileSync(inboxPath(dir, "p"), "utf8").trim().split("\n");
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[0])).toMatchObject({ from: "c1", _ts: "2026-09-17T10:00:00.000Z" });
    const msgs = readInbox(dir, "p");
    expect(msgs.map((m) => m.text)).toEqual(["one", "two"]);
  });
  it("reads an empty or missing inbox as []", () => {
    expect(readInbox(dir, "nobody")).toEqual([]);
  });
  it("skips damaged lines instead of failing", () => {
    appendFileSync(inboxPath(dir, "damaged"), "{half-written\n", "utf8");
    appendHandoff(dir, { from: "c", to: "damaged", kind: "result", text: "ok" });
    expect(readInbox(dir, "damaged").map((m) => m.text)).toEqual(["ok"]);
  });
});

describe("handoffMessage", () => {
  it("prefixes source and kind, collapsing whitespace", () => {
    expect(handoffMessage({ from: "c9", kind: "blocker", text: "cannot\n  proceed" })).toBe(
      "[handoff from c9] (blocker) cannot proceed"
    );
  });
  it("isHandoffMessage recognises exactly that shape (the runner marks the mirror)", () => {
    for (const k of ["proposal", "result", "question", "blocker"]) {
      expect(isHandoffMessage(`[handoff from c1] (${k}) did the thing`)).toBe(true);
    }
    expect(isHandoffMessage("what is your status")).toBe(false);
    expect(isHandoffMessage("[handoff from c1] (memo) not a kind")).toBe(false);
    expect(isHandoffMessage("[handoff from ] (result) missing source")).toBe(false);
  });
});

describe("deliverHandoff", () => {
  it("says the handoff to a running, alive parent", async () => {
    status("busy");
    const said: string[] = [];
    const h = await deliverHandoff(
      dir,
      { from: "c", to: "busy", kind: "result", text: "done it" },
      { say: async (_id, text) => (said.push(text), "ok") }
    );
    expect(said).toEqual(["[handoff from c] (result) done it"]);
    expect(readInbox(dir, "busy")).toHaveLength(1);
    expect(h.text).toBe("done it");
  });
  it("only appends when the parent is finished or gone", async () => {
    status("done-parent", { state: "done" });
    const said: string[] = [];
    await deliverHandoff(
      dir,
      { from: "c", to: "done-parent", kind: "result", text: "late" },
      { say: async (_id, text) => (said.push(text), "ok") }
    );
    expect(said).toEqual([]);
    expect(readInbox(dir, "done-parent").map((m) => m.text)).toEqual(["late"]);
  });
  it("a failing say never fails the delivery (the inbox line is durable)", async () => {
    status("busy2");
    const h = await deliverHandoff(
      dir,
      { from: "c", to: "busy2", kind: "question", text: "hm" },
      { say: async () => { throw new Error("socket busy"); } }
    );
    expect(h.kind).toBe("question");
    expect(readInbox(dir, "busy2")).toHaveLength(1);
  });
});

describe("handoffFromInside", () => {
  it("rejects runs outside a worker, pointing at say", async () => {
    await expect(handoffFromInside(dir, {}, { kind: "question", text: "x" })).rejects.toThrow(
      /not inside a worker.*pai worker say/s
    );
  });
  it("rejects a worker without a worker parent (upward only)", async () => {
    status("orphan");
    await expect(
      handoffFromInside(dir, { PAI_WORKER_ID: "orphan" }, { kind: "question", text: "x" })
    ).rejects.toThrow(/no worker parent.*up the worker tree/);
  });
  it("sends from the env worker to its status parent", async () => {
    status("parent-w");
    status("child-w", { parent: "parent-w" });
    const said: string[] = [];
    const h = await handoffFromInside(
      dir,
      { PAI_WORKER_ID: "child-w" },
      { kind: "proposal", text: "run it on a cheap provider" },
      { say: async (_id, text) => (said.push(text), "ok") }
    );
    expect(h).toMatchObject({ from: "child-w", to: "parent-w", kind: "proposal" });
    expect(said).toHaveLength(1);
  });
});
