/**
 * `pai audit tokens hooks` — token cost of the hooks that fire before the
 * model ever sees a token: SessionStart and UserPromptSubmit run on every
 * new session / every prompt respectively, and whatever they print to
 * stdout is injected into context.
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { claudeHomeDir, claudeProjectsDir, paiHomePath } from "../config/pai-home.js";
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

export interface HookGroup {
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
  /** "observed": a capture for this event in the window; "missing-script":
   *  the command points at a file that does not exist; "configured": never
   *  observed in the window (the hook may silently not be running). */
  state: "configured" | "observed" | "missing-script";
  lastSeen?: string;
  /** For state "missing-script": the expanded path that does not exist. */
  missingPath?: string;
}

export interface HooksReport {
  encoding: string;
  settingsFiles: string[];
  readings: HookReading[];
  totalsByEvent: Record<string, number>;
  preToolUseHooks: { matcher?: string; command: string }[];
  preToolUseRewritesBash: boolean;
}

export function settingsPaths(cwd: string): string[] {
  return [join(claudeHomeDir(), "settings.json"), join(cwd, ".claude", "settings.json")].filter(existsSync);
}

/** settings.json parsed leniently: a malformed file reads as empty. */
export function readSettings(path: string): SettingsJson {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SettingsJson;
  } catch {
    return {};
  }
}

/** Expand ${ADAPTER_DIR}/${PAI_DIR} and $HOME/${HOME}/~ the way the hooks are installed. */
export function expandCommand(command: string, env: Record<string, string>): string {
  const adapterDir = env.ADAPTER_DIR ?? process.env.ADAPTER_DIR ?? env.PAI_DIR ?? process.env.PAI_DIR ?? claudeHomeDir();
  return command
    .replace(/\$\{ADAPTER_DIR\}/g, adapterDir)
    .replace(/\$\{PAI_DIR\}/g, adapterDir)
    .replace(/\$\{HOME\}/g, homedir())
    .replace(/\$HOME\b/g, homedir())
    .replace(/^~(?=\/|$)/, homedir());
}

function syntheticStdin(cwd: string, eventName: string): string {
  const sessionId = randomUUID();
  return JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: eventName,
    prompt: "audit",
    transcript_path: join(claudeProjectsDir(), "audit", `${sessionId}.jsonl`),
  });
}

export function runHook(command: string, cwd: string, eventName: string): { stdout: string; error?: string } {
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

export const NOT_RUN = "not run (pass --run to execute hooks)";

const AUDITED_EVENTS = ["SessionStart", "UserPromptSubmit"];

/** Hook events the capture hook records, so a configured hook can be checked
 *  against what actually fired. */
export const OBSERVABLE_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "PreCompact",
  "Notification",
];

/** Default observation window for `--since`. */
export const DEFAULT_SINCE_HOURS = 24;

/** Where capture-all-events writes its JSONL: PAI_HOME/History/raw-outputs. */
export function defaultCaptureDir(): string {
  return join(paiHomePath("History"), "raw-outputs");
}

/** Live capture file or a rotated backup (`<day>_all-events.jsonl.1`, `.2`, ...). */
const CAPTURE_FILE = /\.jsonl(\.\d+(-\d+)?)?$/;

/** Capture files (in the YYYY-MM month directories) modified since `sinceMs`. */
function captureFilesSince(captureDir: string, sinceMs: number): string[] {
  if (!existsSync(captureDir)) return [];
  const files: string[] = [];
  const monthDirs = readdirSync(captureDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
    .map((d) => join(captureDir, d.name));
  for (const monthDir of monthDirs) {
    for (const name of readdirSync(monthDir)) {
      if (!CAPTURE_FILE.test(name)) continue;
      const file = join(monthDir, name);
      try {
        if (statSync(file).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      files.push(file);
    }
  }
  return files;
}

/** Every line of the capture files modified since `sinceMs`, streamed file by file. */
async function* captureLinesSince(captureDir: string, sinceMs: number): AsyncGenerator<string> {
  for (const file of captureFilesSince(captureDir, sinceMs)) {
    yield* createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  }
}

/**
 * Counts hook events in the raw-capture JSONL files modified since `sinceMs`
 * (capture-all-events lines carry `hook_event_type` and `timestamp`). Files
 * are read line by line; malformed lines are skipped.
 */
export async function observedHookEvents(captureDir: string, sinceMs: number): Promise<Map<string, { count: number; last: string }>> {
  const observed = new Map<string, { count: number; last: string }>();
  for await (const raw of captureLinesSince(captureDir, sinceMs)) {
    foldObservedLine(raw, observed);
  }
  return observed;
}

/**
 * Counts MCP tool calls per server in the capture files modified since
 * `sinceMs`: tool names of the form `mcp__<server>__<tool>` (all-events
 * payload `tool_name`, tool-outputs line `tool`).
 */
export async function observedMcpServers(captureDir: string, sinceMs: number): Promise<Map<string, { count: number; last: string }>> {
  const observed = new Map<string, { count: number; last: string }>();
  for await (const raw of captureLinesSince(captureDir, sinceMs)) {
    if (!raw.includes("mcp__")) continue;
    let parsed: { payload?: { tool_name?: string }; tool?: string; timestamp?: number | string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const toolName = parsed.payload?.tool_name ?? parsed.tool;
    if (!toolName || !toolName.startsWith("mcp__")) continue;
    const server = toolName.split("__")[1];
    if (!server) continue;
    const ts = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.parse(String(parsed.timestamp ?? ""));
    const last = new Date(Number.isNaN(ts) ? Date.now() : ts).toISOString();
    const entry = observed.get(server);
    if (entry) {
      entry.count += 1;
      if (last > entry.last) entry.last = last;
    } else {
      observed.set(server, { count: 1, last });
    }
  }
  return observed;
}

/**
 * The script a hook command points at, or null when it points at none: the
 * first token when that is a path, else the script following a `node`/`sh`/
 * `bash` interpreter. Tokens still holding `$` or `*` are unexpanded or
 * globbed and can't be checked.
 */
function commandScript(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  const first = tokens[0];
  if (first && first.includes("/")) return first.includes("$") || first.includes("*") ? null : first;
  if (first === "node" || first === "sh" || first === "bash") {
    const script = tokens[1];
    if (!script || !script.includes("/")) return null;
    if (script.includes("$") || script.includes("*")) return null;
    return script;
  }
  return null;
}

/** The missing script path for a hook command, or null when nothing is missing
 *  (a hook script that was moved or deleted — the hook silently never runs). */
export function missingScriptPath(command: string): string | null {
  const script = commandScript(command);
  return script && !existsSync(script) ? script : null;
}

/** Seam for tests: a real shell under a 20s wall-clock kill is load-dependent. */
export type HookRunner = typeof runHook;

/**
 * Lists every SessionStart / UserPromptSubmit hook. Without `run` the hooks are only
 * listed (tokens 0, marked not run): a project's settings.json is untrusted input and
 * its hooks execute with shell:true. Pass `runHook` (CLI `--run`) to measure them.
 */
export interface AuditHooksOptions {
  run?: HookRunner;
  /** Capture directory to scan for observed events (default: PAI_HOME/History/raw-outputs). */
  captureDir?: string;
  /** Observation window in hours (default 24). */
  sinceHours?: number;
  /** "Now" for the window; injectable for tests. */
  now?: number;
}

export function auditHooks(cwd: string, run?: HookRunner | AuditHooksOptions, maybeOpts?: AuditHooksOptions): HooksReport {
  // Legacy second positional was a HookRunner; options object is the new form.
  const opts: AuditHooksOptions = typeof run === "function" ? (maybeOpts ?? {}) : (run ?? {});
  const runner = typeof run === "function" ? run : undefined;
  const sinceHours = opts.sinceHours ?? DEFAULT_SINCE_HOURS;
  const now = opts.now ?? Date.now();
  const captureDir = opts.captureDir ?? defaultCaptureDir();
  const observed = observedHookEventsSync(captureDir, now - sinceHours * 3_600_000);

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
          const { stdout, error } = runner ? runner(command, cwd, eventName) : { stdout: "", error: NOT_RUN };
          const tokens = countTokens(stdout);
          totalsByEvent[eventName] += tokens;
          const seen = observed.get(eventName);
          const missing = missingScriptPath(command);
          readings.push({
            event: eventName,
            matcher: group.matcher,
            command,
            tokens,
            error,
            state: missing ? "missing-script" : seen ? "observed" : "configured",
            lastSeen: seen?.last,
            missingPath: missing ?? undefined,
          });
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

/** Sync variant used by auditHooks; same folding as observedHookEvents. */
function observedHookEventsSync(captureDir: string, sinceMs: number): Map<string, { count: number; last: string }> {
  const observed = new Map<string, { count: number; last: string }>();
  for (const file of captureFilesSince(captureDir, sinceMs)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      foldObservedLine(raw, observed);
    }
  }
  return observed;
}

function foldObservedLine(raw: string, observed: Map<string, { count: number; last: string }>): void {
  if (!raw.includes("hook_event_type")) return;
  let parsed: { hook_event_type?: string; timestamp?: number };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const event = parsed.hook_event_type;
  if (!event) return;
  const ts = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
  const last = new Date(ts).toISOString();
  const entry = observed.get(event);
  if (entry) {
    entry.count += 1;
    if (last > entry.last) entry.last = last;
  } else {
    observed.set(event, { count: 1, last });
  }
}
