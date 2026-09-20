/**
 * `pai audit tokens hooks` — token cost of the hooks that fire before the
 * model ever sees a token: SessionStart and UserPromptSubmit run on every
 * new session / every prompt respectively, and whatever they print to
 * stdout is injected into context.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { countTokens, TOKEN_ENCODING } from "./tokens.js";

const HOOK_TIMEOUT_MS = 20_000;

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

interface SettingsJson {
  env?: Record<string, string>;
  hooks?: Record<string, HookGroup[]>;
}

export interface HookReading {
  event: string;
  matcher?: string;
  command: string;
  tokens: number;
  error?: string;
}

export interface HooksReport {
  encoding: string;
  settingsFiles: string[];
  readings: HookReading[];
  totalsByEvent: Record<string, number>;
  preToolUseHooks: { matcher?: string; command: string }[];
  preToolUseRewritesBash: boolean;
}

function settingsPaths(cwd: string): string[] {
  return [join(homedir(), ".claude", "settings.json"), join(cwd, ".claude", "settings.json")].filter(existsSync);
}

function readSettings(path: string): SettingsJson {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SettingsJson;
  } catch {
    return {};
  }
}

/** Expand ${PAI_DIR} and $HOME/${HOME} the way settings.json's own hooks do. */
function expandCommand(command: string, env: Record<string, string>): string {
  const paiDir = env.PAI_DIR ?? process.env.PAI_DIR ?? join(homedir(), ".claude");
  return command
    .replace(/\$\{PAI_DIR\}/g, paiDir)
    .replace(/\$\{HOME\}/g, homedir())
    .replace(/\$HOME\b/g, homedir());
}

function syntheticStdin(cwd: string, eventName: string): string {
  const sessionId = randomUUID();
  return JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: eventName,
    prompt: "audit",
    transcript_path: join(homedir(), ".claude", "projects", "audit", `${sessionId}.jsonl`),
  });
}

function runHook(command: string, cwd: string, eventName: string): { stdout: string; error?: string } {
  const result = spawnSync(command, {
    shell: true,
    cwd,
    input: syntheticStdin(cwd, eventName),
    encoding: "utf8",
    timeout: HOOK_TIMEOUT_MS,
  });
  if (result.error) return { stdout: "", error: result.error.message };
  if (result.signal) return { stdout: result.stdout ?? "", error: `killed by ${result.signal} (timeout?)` };
  return { stdout: result.stdout ?? "" };
}

const AUDITED_EVENTS = ["SessionStart", "UserPromptSubmit"];

export function auditHooks(cwd: string): HooksReport {
  const settingsFiles = settingsPaths(cwd);
  const readings: HookReading[] = [];
  const totalsByEvent: Record<string, number> = {};
  const preToolUseHooks: { matcher?: string; command: string }[] = [];
  let preToolUseRewritesBash = false;

  for (const settingsPath of settingsFiles) {
    const settings = readSettings(settingsPath);
    const env = settings.env ?? {};

    for (const eventName of AUDITED_EVENTS) {
      const groups = settings.hooks?.[eventName] ?? [];
      totalsByEvent[eventName] = totalsByEvent[eventName] ?? 0;
      for (const group of groups) {
        for (const entry of group.hooks ?? []) {
          if (!entry.command) continue;
          const command = expandCommand(entry.command, env);
          const { stdout, error } = runHook(command, cwd, eventName);
          const tokens = countTokens(stdout);
          totalsByEvent[eventName] += tokens;
          readings.push({ event: eventName, matcher: group.matcher, command, tokens, error });
        }
      }
    }

    for (const group of settings.hooks?.PreToolUse ?? []) {
      for (const entry of group.hooks ?? []) {
        if (!entry.command) continue;
        preToolUseHooks.push({ matcher: group.matcher, command: expandCommand(entry.command, env) });
        if (group.matcher === "Bash") preToolUseRewritesBash = true;
      }
    }
  }

  return { encoding: TOKEN_ENCODING, settingsFiles, readings, totalsByEvent, preToolUseHooks, preToolUseRewritesBash };
}
