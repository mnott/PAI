/**
 * Tests for scope keys, path shortening and the ledger line format.
 *
 * All pure / tmp-dir file functions — nothing here spawns claude or osascript.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tabKey, itermUuid, workerInScope, recordSessionMapEntry, resolveSpawnerSession, sessionMapPath } from "./scope.js";
import { relPath, unifiedDiffLines, makeColor } from "./render.js";
import { appendLedger, parseLedgerLine, ledgerSummary } from "./ledger.js";
import { resultFromOutput } from "./run.js";
import { statusPath, eventsPath, ledgerPath } from "./paths.js";
import { saveStatus, type WorkerStatus } from "./status.js";

describe("tabKey", () => {
  it("extracts w<n>t<n> and ignores pane suffixes", () => {
    expect(tabKey("w0t3p1:UUID-A")).toBe("w0t3");
    expect(tabKey("w12t0p7:UUID-B")).toBe("w12t0");
  });
  it("returns empty for malformed or non-iTerm ids", () => {
    expect(tabKey("")).toBe("");
    expect(tabKey("tmux-42")).toBe("");
    expect(tabKey("w0")).toBe("");
  });
});

describe("itermUuid", () => {
  it("takes the segment after the last colon", () => {
    expect(itermUuid("w0t3p1:AAA-BBB")).toBe("AAA-BBB");
  });
});

describe("workerInScope", () => {
  const base = { id: "x", label: "", cwd: "", term: "w0t3p0:U1" } as WorkerStatus;
  it("matches same tab across panes when no session id is stored", () => {
    expect(workerInScope(base, "w0t3p2:U2")).toBe(true);
  });
  it("does not match another tab", () => {
    expect(workerInScope(base, "w1t0p0:U3")).toBe(false);
  });
  it("prefers the session id when the worker has one", () => {
    const withSession = { ...base, session: { id: "S-1", name: "pai" } };
    expect(workerInScope(withSession, "w9t9p0:S-1")).toBe(true);
    expect(workerInScope(withSession, "w0t3p2:U2")).toBe(false);
  });
});

describe("spawner session map", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-session-map-"));
  const cwd = "/proj/pai";
  const t0 = 1_700_000_000_000;

  it("resolves the session a fresh entry records, per cwd", () => {
    recordSessionMapEntry(dir, cwd, "sess-1", t0);
    expect(resolveSpawnerSession(dir, cwd, {}, t0 + 1000)).toBe("sess-1");
    expect(resolveSpawnerSession(dir, "/other", {}, t0 + 1000)).toBeNull();
  });
  it("ignores entries past the TTL", () => {
    recordSessionMapEntry(dir, cwd, "sess-2", t0);
    expect(resolveSpawnerSession(dir, cwd, {}, t0 + 60 * 60_000)).toBeNull();
  });
  it("overwrites the previous session and prunes stale cwds", () => {
    recordSessionMapEntry(dir, cwd, "sess-2", t0);
    recordSessionMapEntry(dir, "/gone", "sess-3", t0);
    recordSessionMapEntry(dir, cwd, "sess-4", t0 + 2 * 60 * 60_000);
    const map = JSON.parse(readFileSync(sessionMapPath(dir), "utf8")) as Record<string, { session: string }>;
    expect(map[cwd].session).toBe("sess-4");
    expect(map["/gone"]).toBeUndefined();
  });
  it("inherits the spawner of the worker this runs inside", () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-spawner-"));
    saveStatus(logDir, {
      ...({ id: "parent-1", label: "", cwd: "", term: "", pid: 1, provider: "p", model: "m",
        state: "running", started: "2026-09-17 10:00:00", updated: "2026-09-17 10:00:00",
        turns: 0, tools: 0, last: "", rc: null, secs: null } as WorkerStatus),
      spawnerSession: "sess-9",
    });
    expect(resolveSpawnerSession(logDir, "/anywhere", { PAI_WORKER_ID: "parent-1" })).toBe("sess-9");
  });
  it("returns null without a map", () => {
    expect(resolveSpawnerSession(join(dir, "missing"), cwd, {}, t0)).toBeNull();
  });
});

describe("relPath", () => {
  it("shortens paths inside cwd", () => {
    expect(relPath("/a/b/c/src/x.ts", "/a/b/c")).toBe("src/x.ts");
  });
  it("leaves outside paths alone", () => {
    expect(relPath("/elsewhere/x.ts", "/a/b/c")).toBe("/elsewhere/x.ts");
  });
});

describe("unifiedDiffLines", () => {
  it("shows only the changed hunk", () => {
    expect(unifiedDiffLines("one\ntwo\nthree", "one\nTWO\nthree")).toEqual(["-two", "+TWO"]);
  });
  it("shows a pure insertion", () => {
    expect(unifiedDiffLines("a\nb", "a\nb\nc")).toEqual(["+c"]);
  });
});

describe("makeColor", () => {
  it("paints only when enabled (MCP output must stay plain)", () => {
    expect(makeColor(true)("red", "x")).toBe("\x1b[31mx\x1b[0m");
    expect(makeColor(false)("red", "x")).toBe("x");
  });
});

describe("ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-workers-ledger-"));
  const file = ledgerPath(dir);

  it("writes a stable single-line format that parses back", () => {
    appendLedger(file, "WORKER-START", { id: "ab12", provider: "glm", label: "fix buttons" });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} WORKER-START id=ab12 provider=glm label=fix buttons$/);
    const parsed = parseLedgerLine(lines[0]);
    expect(parsed?.event).toBe("WORKER-START");
    expect(parsed?.fields.provider).toBe("glm");
  });

  it("collapses whitespace inside values (one line per event, always)", () => {
    appendLedger(file, "DENIED-ANTHROPIC-AGENT", { label: "a  b\t c" });
    const line = readFileSync(file, "utf8").trim().split("\n").pop()!;
    expect(line).not.toMatch(/\t/);
    expect(line).toMatch(/label=a b c$/);
  });

  it("summarizes counts", () => {
    writeFileSync(file, "", "utf8");
    appendLedger(file, "WORKER-START", { id: "1" });
    appendLedger(file, "WORKER-END", { id: "1", rc: "0" });
    appendLedger(file, "DENIED-ANTHROPIC-AGENT", {});
    const s = ledgerSummary(file, "all", 5);
    expect(s?.started).toBe(1);
    expect(s?.endedOk).toBe(1);
    expect(s?.denied).toBe(1);
  });
});

describe("paths", () => {
  it("derives every artifact from the worker id", () => {
    expect(statusPath("/logs", "ab12")).toBe("/logs/ab12.status");
    expect(eventsPath("/logs", "ab12")).toBe("/logs/ab12.jsonl");
    expect(ledgerPath("/logs")).toBe("/logs/ledger.log");
  });
});

describe("resultFromOutput", () => {
  it("reads the result field of a single JSON object", () => {
    expect(resultFromOutput('{"type":"result","result":"pong"}\n')).toBe("pong");
  });
  it("reads the last result event out of a --verbose JSON array", () => {
    const arr = JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "assistant", message: {} },
      { type: "result", result: "pong" },
    ]);
    expect(resultFromOutput(arr)).toBe("pong");
  });
  it("falls back to raw text when nothing parses", () => {
    expect(resultFromOutput("Error: nope\n")).toBe("Error: nope");
  });
  it("is empty for empty output", () => {
    expect(resultFromOutput("   \n")).toBe("");
  });
});
