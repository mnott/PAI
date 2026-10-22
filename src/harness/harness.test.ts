/**
 * harness.test.ts — the adapter seam over fake harness stores: a temp HOME
 * holds a Claude Code projects dir and a temp CODEX_HOME holds a rollout
 * file. Both adapters list sessions, replay the expected event kinds in
 * order, skip malformed lines, and detect() false when the store is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedHome = process.env.HOME;
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const savedCodexHome = process.env.CODEX_HOME;

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-harness-"));
  dirs.push(d);
  return d;
}

let home: string;
let codexHome: string;
let claudeCodeAdapter: typeof import("./claude-code.js")["claudeCodeAdapter"];
let codexAdapter: typeof import("./codex.js")["codexAdapter"];
let harnessAdapters: typeof import("./index.js")["harnessAdapters"];
let enabledHarnessNames: typeof import("./index.js")["enabledHarnessNames"];

const CWD = "/tmp/proj";
const ENCODED = "-tmp-proj";

beforeAll(async () => {
  home = newDir();
  codexHome = newDir();
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.CODEX_HOME = codexHome;
  ({ claudeCodeAdapter } = await import("./claude-code.js"));
  ({ codexAdapter } = await import("./codex.js"));
  ({ harnessAdapters, enabledHarnessNames } = await import("./index.js"));
});

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const [k, v] of [["HOME", savedHome], ["CLAUDE_CONFIG_DIR", savedClaudeConfigDir], ["CODEX_HOME", savedCodexHome]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("claude-code toSession", () => {
  it("skips a transcript deleted between listing and stat", async () => {
    const { toSession } = await import("./claude-code.js");
    expect(toSession("claude-code", "gone.jsonl", newDir())).toBeNull();
  });

  it("reads cwd from the head and the last timestamp from the tail of a large file", async () => {
    const { toSession } = await import("./claude-code.js");
    const dir = newDir();
    const filler = JSON.stringify({ type: "x", timestamp: "2026-10-22T10:00:01.000Z", pad: "y".repeat(1000) });
    const lines = [JSON.stringify({ type: "user", timestamp: "2026-10-22T10:00:00.000Z", cwd: CWD })];
    for (let i = 0; i < 400; i++) lines.push(filler);
    lines.push(JSON.stringify({ type: "x", timestamp: "2026-10-22T11:00:00.000Z" }));
    writeFileSync(join(dir, "big.jsonl"), lines.join("\n") + "\n");
    const s = toSession("claude-code", "big.jsonl", dir)!;
    expect(s.cwd).toBe(CWD);
    expect(s.startedAt).toBe("2026-10-22T10:00:00.000Z");
    expect(s.updatedAt).toBe("2026-10-22T11:00:00.000Z");
  });
});

describe("claude-code adapter", () => {
  it("lists sessions and replays events in order, skipping malformed lines", async () => {
    const dir = join(home, ".claude", "projects", ENCODED);
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-10-22T10:00:00.000Z", cwd: CWD, message: { role: "user", content: "hello" } }),
      "not json at all",
      JSON.stringify({ type: "assistant", timestamp: "2026-10-22T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "running" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
      JSON.stringify({ type: "user", timestamp: "2026-10-22T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", content: "Exit code 1\nnope" }] } }),
      JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-22T10:00:03.000Z" }),
    ];
    writeFileSync(join(dir, "abc12345.jsonl"), lines.join("\n") + "\n");

    expect(claudeCodeAdapter.detect()).toBe(true);
    const sessions = claudeCodeAdapter.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["abc12345"]);
    const s = sessions[0]!;
    expect(s.harness).toBe("claude-code");
    expect(s.cwd).toBe(CWD);
    expect(s.startedAt).toBe("2026-10-22T10:00:00.000Z");
    expect(s.updatedAt).toBe("2026-10-22T10:00:03.000Z");

    const events = [...claudeCodeAdapter.readEvents(s)];
    expect(events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_call", "tool_result"]);
    expect(events[0]!.text).toBe("hello");
    expect(events[2]!.tool).toBe("Bash");
    expect(events[2]!.input).toEqual({ command: "ls" });
    expect(events[3]!.exitCode).toBe(1);
    expect(events[3]!.text).toContain("nope");
    for (const e of events) {
      expect(e.harness).toBe("claude-code");
      expect(e.sessionId).toBe("abc12345");
      expect(e.source).toBe("transcript");
      expect(e.fidelity).toBe("observed");
    }

    // cwd filter and the missing-dir case
    expect(claudeCodeAdapter.listSessions({ cwd: CWD }).length).toBe(1);
    expect(claudeCodeAdapter.listSessions({ cwd: "/tmp/other" })).toEqual([]);
  });

  it("detect() is false when the projects dir is missing", () => {
    process.env.CLAUDE_CONFIG_DIR = join(newDir(), ".claude");
    expect(claudeCodeAdapter.detect()).toBe(false);
    expect(claudeCodeAdapter.listSessions()).toEqual([]);
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  });
});

describe("codex adapter", () => {
  it("lists rollout files and replays events in order, skipping unknown and malformed entries", () => {
    const dir = join(codexHome, "sessions", "2026", "10", "22");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-10-22T09:00:00.000Z", payload: { id: "rollout-x" } }),
      JSON.stringify({ type: "message", timestamp: "2026-10-22T09:00:01.000Z", payload: { type: "message", role: "user", content: "hi" } }),
      "{ broken json",
      JSON.stringify({ type: "message", timestamp: "2026-10-22T09:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "working" }] } }),
      JSON.stringify({ type: "function_call", timestamp: "2026-10-22T09:00:03.000Z", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}' } }),
      JSON.stringify({ type: "function_call_output", timestamp: "2026-10-22T09:00:04.000Z", payload: { type: "function_call_output", output: "ok" } }),
      JSON.stringify({ type: "something_new", timestamp: "2026-10-22T09:00:05.000Z", payload: { type: "unknown_kind" } }),
    ];
    const file = join(dir, "rollout-2026-10-22T09-00-00-abc.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");

    expect(codexAdapter.detect()).toBe(true);
    const sessions = codexAdapter.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["rollout-2026-10-22T09-00-00-abc"]);
    const s = sessions[0]!;
    expect(s.harness).toBe("codex");
    expect(s.path).toBe(file);
    expect(s.startedAt).toBe("2026-10-22T09:00:00.000Z");
    expect(s.updatedAt).toBe("2026-10-22T09:00:05.000Z");

    const events = [...codexAdapter.readEvents(s)];
    expect(events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_call", "tool_result"]);
    expect(events[0]!.text).toBe("hi");
    expect(events[2]!.tool).toBe("shell");
    expect(events[2]!.input).toEqual({ cmd: "ls" });
    expect(events[3]!.text).toBe("ok");
    for (const e of events) {
      expect(e.harness).toBe("codex");
      expect(e.sessionId).toBe("rollout-2026-10-22T09-00-00-abc");
      expect(e.source).toBe("transcript");
      expect(e.fidelity).toBe("observed");
    }
  });

  it("detect() is false when the sessions dir is missing", () => {
    process.env.CODEX_HOME = newDir();
    expect(codexAdapter.detect()).toBe(false);
    expect(codexAdapter.listSessions()).toEqual([]);
    process.env.CODEX_HOME = codexHome;
  });
});

describe("registry", () => {
  it("harnessAdapters() returns detected adapters of the enabled set; default config enables only claude-code", () => {
    expect(enabledHarnessNames()).toEqual(["claude-code"]);
    expect(harnessAdapters().map((a) => a.name)).toEqual(["claude-code"]);
    expect(harnessAdapters(["claude-code", "codex"]).map((a) => a.name)).toEqual(["claude-code", "codex"]);
    // an adapter whose store is absent never appears, even when named
    process.env.CLAUDE_CONFIG_DIR = join(newDir(), ".claude");
    expect(harnessAdapters(["claude-code", "codex"]).map((a) => a.name)).toEqual(["codex"]);
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  });
});
