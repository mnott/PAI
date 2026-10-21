import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aibrokerHomeDir,
  aibrokerSocketPath,
  daemonLogPath,
  paiCacheDir,
  paiSocketPath,
  schedulerLogPath,
} from "./runtime-paths.js";
import { claudeHomeDir, claudeProjectsDir, legacyConfigDir, livePaiHomeDirs, paiHomePath } from "./config/pai-home.js";
import { statuslineStateFilePath } from "./hooks/ts/lib/context-fill.js";
import { contextHandoverCachePath } from "./hooks/ts/lib/context-handover-cache.js";
import { whisperConfirmMarkerPath } from "./hooks/ts/lib/whisper-confirm.js";
import { triggerStatePath } from "./session/context-handover-trigger.js";

const KEYS = [
  "PAI_HOME",
  "PAI_DAEMON_LOG_PATH",
  "PAI_SCHEDULER_LOG_PATH",
  "PAI_CACHE_DIR",
  "PAI_SOCKET_PATH",
  "PAI_AIBROKER_SOCKET_PATH",
  "CLAUDE_CONFIG_DIR",
  "AIBROKER_HOME",
] as const;

describe("runtime paths resolve under PAI home, sockets stay at the /tmp meeting point", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    home = mkdtempSync(join(tmpdir(), "pai-runtime-paths-"));
    process.env.PAI_HOME = home;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("puts logs and the status line cache under PAI_HOME", () => {
    expect(daemonLogPath()).toBe(join(home, "logs", "daemon.log"));
    expect(schedulerLogPath()).toBe(join(home, "logs", "scheduler.log"));
    expect(paiCacheDir()).toBe(join(home, "cache"));
  });

  it("keeps the socket defaults and honours the env overrides", () => {
    expect(paiSocketPath()).toBe("/tmp/pai.sock");
    expect(aibrokerSocketPath()).toBe("/tmp/aibroker.sock");
    process.env.PAI_SOCKET_PATH = "/tmp/x.sock";
    expect(paiSocketPath()).toBe("/tmp/x.sock");
  });

  it("env overrides still win for logs and cache", () => {
    process.env.PAI_DAEMON_LOG_PATH = "/x/d.log";
    process.env.PAI_CACHE_DIR = "/x/cache";
    expect(daemonLogPath()).toBe("/x/d.log");
    expect(paiCacheDir()).toBe("/x/cache");
  });

  it("claude dirs honour CLAUDE_CONFIG_DIR and aibroker honours AIBROKER_HOME", () => {
    process.env.CLAUDE_CONFIG_DIR = "/c/claude";
    process.env.AIBROKER_HOME = "/c/ab";
    expect(claudeHomeDir()).toBe("/c/claude");
    expect(claudeProjectsDir()).toBe("/c/claude/projects");
    expect(aibrokerHomeDir()).toBe("/c/ab");
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeHomeDir().endsWith("/.claude")).toBe(true);
  });

  it("legacy helpers", () => {
    expect(legacyConfigDir().endsWith("/.config/pai")).toBe(true);
    expect(livePaiHomeDirs("/h")).toEqual(["/h/.pai", "/h/.claude/pai"]);
  });

  it("hook and session state files no longer live in the shared tmpdir", () => {
    expect(statuslineStateFilePath("s1")).toBe(join(home, "cache", "pai-context-s1.json"));
    expect(contextHandoverCachePath("s1")).toBe(join(home, "cache", "pai-context-handover-s1.json"));
    expect(whisperConfirmMarkerPath("s1")).toBe(paiHomePath("state", "whisper-confirm", "s1"));
    expect(triggerStatePath("s1")).toBe(paiHomePath("state", "context-handover-fired-s1.json"));
  });
});
