import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendRawCapture, captureEventId, localCaptureDate, redactDeep } from "./raw-capture.js";
import { analyzeSession, formatSessionDocument } from "./session-summary.js";
import { fakeGithub } from "../../../utils/fake-secret.js";

// Fake token-shaped fixture assembled at runtime so no scanner flags a literal.
const FAKE_GHP = fakeGithub("p", "abcdefghijklmnopqrstuvwxyz0123");

describe("captureEventId", () => {
  it("is stable for equal input and 16 hex chars", () => {
    const a = captureEventId({ sessionId: "s1", toolUseId: "t1", event: "PostToolUse", ts: "2026-10-22T00:00:00Z" });
    const b = captureEventId({ sessionId: "s1", toolUseId: "t1", event: "PostToolUse", ts: "2026-10-22T00:00:00Z" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs when toolUseId differs", () => {
    const a = captureEventId({ sessionId: "s1", toolUseId: "t1", event: "PostToolUse", ts: "T" });
    const b = captureEventId({ sessionId: "s1", toolUseId: "t2", event: "PostToolUse", ts: "T" });
    expect(a).not.toBe(b);
  });

  it("uses empty strings for missing parts", () => {
    expect(captureEventId({})).toBe(captureEventId({ sessionId: "", toolUseId: "", event: "", ts: "" }));
  });
});

describe("redactDeep", () => {
  it("masks secret lines in nested tool I/O and keeps the rest", () => {
    const out = redactDeep({
      input: { command: "cat .env" },
      output: { stdout: `FOO=1\nAPI_KEY=abc123\nGITHUB_TOKEN=${FAKE_GHP}` },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain(FAKE_GHP);
    expect(out.output.stdout.startsWith("FOO=1")).toBe(true);
    expect(out.input.command).toBe("cat .env");
  });
});

describe("appendRawCapture", () => {
  it("creates dirs 0700 and files 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "rawcap-"));
    const dir = join(root, "raw-outputs", "2026-10");
    const file = join(dir, "x.jsonl");
    appendRawCapture(file, dir, "{}\n");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rotates at the cap and shifts older backups instead of overwriting them", () => {
    const root = mkdtempSync(join(tmpdir(), "rawcap-"));
    const file = join(root, "x.jsonl");
    appendRawCapture(file, root, "aaaa\n", 12);
    appendRawCapture(file, root, "bbbb\n", 12);
    appendRawCapture(file, root, "cccc\n", 12);
    expect(readFileSync(file, "utf-8")).toBe("cccc\n");
    expect(readFileSync(`${file}.1`, "utf-8")).toBe("aaaa\nbbbb\n");
    appendRawCapture(file, root, "dddd\n", 12);
    appendRawCapture(file, root, "eeee\n", 12);
    expect(readdirSync(root).sort()).toEqual(["x.jsonl", "x.jsonl.1", "x.jsonl.2"]);
    expect(readFileSync(`${file}.1`, "utf-8")).toBe("cccc\ndddd\n");
    expect(readFileSync(`${file}.2`, "utf-8")).toBe("aaaa\nbbbb\n");
  });
});

describe("capture hook provenance fields", () => {
  const repoRoot = pathJoin(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

  function runHook(script: string, args: string[], stdin: string, home: string) {
    return spawnSync("npx", ["tsx", pathJoin(repoRoot, script), ...args], {
      input: stdin,
      encoding: "utf-8",
      env: { ...process.env, PAI_HOME: home, ADAPTER_DIR: pathJoin(home, "adapter") },
      timeout: 60_000,
    });
  }

  it("tool-output capture carries source, fidelity and eventId", () => {
    const home = mkdtempSync(join(tmpdir(), "cap-hook-"));
    const stdin = JSON.stringify({
      session_id: "s1", tool_use_id: "tu1", tool_name: "Bash",
      tool_input: { command: "ls" }, tool_response: { stdout: "ok" },
      timestamp: "2026-10-22T00:00:00Z",
    });
    runHook("src/hooks/ts/post-tool-use/capture-tool-output.ts", [], stdin, home);
    // Same local-date naming as capture-tool-output.ts — never toISOString
    const day = localCaptureDate();
    const file = join(home, "History", "raw-outputs", day.substring(0, 7), `${day}_tool-outputs.jsonl`);
    const entry = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(entry.source).toBe("hook");
    expect(entry.fidelity).toBe("observed");
    expect(entry.eventId).toMatch(/^[0-9a-f]{16}$/);
    expect(entry.eventId).toBe(captureEventId({
      sessionId: "s1", toolUseId: "tu1", event: "PostToolUse", ts: "2026-10-22T00:00:00Z",
    }));
  });

  it("all-events capture carries source, fidelity and eventId", () => {
    const home = mkdtempSync(join(tmpdir(), "cap-hook-"));
    const stdin = JSON.stringify({ session_id: "s1", tool_use_id: "tu1" });
    runHook("src/hooks/ts/capture-all-events.ts", ["--event-type", "PreToolUse"], stdin, home);
    // Same local-date naming as getEventsFilePath() in capture-all-events.ts — never toISOString
    const tz = process.env.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localDate = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
    const year = localDate.getFullYear();
    const month = String(localDate.getMonth() + 1).padStart(2, "0");
    const day = String(localDate.getDate()).padStart(2, "0");
    const dir = join(home, "History", "raw-outputs", `${year}-${month}`);
    const entry = JSON.parse(readFileSync(join(dir, `${year}-${month}-${day}_all-events.jsonl`), "utf-8").trim());
    expect(entry.source).toBe("hook");
    expect(entry.fidelity).toBe("observed");
    expect(entry.eventId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("session summary", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hist-"));
    mkdirSync(join(home, "History"));
    vi.stubEnv("PAI_HOME", home);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("formats the time as HH:MM:SS", () => {
    const doc = formatSessionDocument("2026-10-18-184827", { session_id: "s1" }, {
      focus: "f", duration: 0, toolsUsed: [], filesChanged: [], commandsExecuted: [],
    });
    expect(doc).toContain("**Time:** 18:48:27");
    expect(doc).toContain("**Session ID:** s1");
  });

  it("lists only its own session", async () => {
    const { historyDir } = await import("./pai-paths.js");
    const ym = new Date().toISOString().substring(0, 7);
    const dir = join(historyDir(), "raw-outputs", ym);
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().substring(0, 10);
    const lines = [
      { tool: "Bash", input: { command: "mine" }, session: "s1" },
      { tool: "Write", input: { file_path: "/other" }, session: "s2" },
      { tool: "Edit", input: { file_path: "/legacy" } },
    ].map(e => JSON.stringify(e)).join("\n");
    writeFileSync(join(dir, `${day}_tool-outputs.jsonl`), lines + "\n");
    const info = await analyzeSession("s1", ym);
    expect(info.commandsExecuted).toEqual(["mine"]);
    expect(info.filesChanged).toEqual([]);
    expect(info.toolsUsed).toEqual(["Bash"]);
  });
});
