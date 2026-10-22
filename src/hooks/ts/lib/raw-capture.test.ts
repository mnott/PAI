import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendRawCapture, redactDeep } from "./raw-capture.js";
import { analyzeSession, formatSessionDocument } from "./session-summary.js";

describe("redactDeep", () => {
  it("masks secret lines in nested tool I/O and keeps the rest", () => {
    const out = redactDeep({
      input: { command: "cat .env" },
      output: { stdout: "FOO=1\nAPI_KEY=abc123\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123" },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
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

  it("rotates at the cap and keeps one backup", () => {
    const root = mkdtempSync(join(tmpdir(), "rawcap-"));
    const file = join(root, "x.jsonl");
    appendRawCapture(file, root, "aaaa\n", 12);
    appendRawCapture(file, root, "bbbb\n", 12);
    appendRawCapture(file, root, "cccc\n", 12);
    expect(readFileSync(file, "utf-8")).toBe("cccc\n");
    expect(readFileSync(`${file}.1`, "utf-8")).toBe("aaaa\nbbbb\n");
    appendRawCapture(file, root, "dddd\n", 12);
    appendRawCapture(file, root, "eeee\n", 12);
    expect(readdirSync(root).sort()).toEqual(["x.jsonl", "x.jsonl.1"]);
    expect(readFileSync(`${file}.1`, "utf-8")).toBe("cccc\ndddd\n");
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
