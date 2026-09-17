/**
 * fallback.ts — machine-wide Claude Code fallback to a worker provider.
 *
 * When the Anthropic plan runs out, `pai worker fallback on <provider>`
 * points EVERY new Claude Code process on this machine at that provider:
 * interactive sessions, task-bus sessions, the daemon's headless summarizer.
 * It writes the provider's base URL, token (read from its key file at switch
 * time — so the token then sits in settings.json until `off`), the three
 * DEFAULT_*_MODEL pins, its extra env (API_TIMEOUT_MS …) plus tool search on
 * and nonessential traffic off into the `env` block of ~/.claude/settings.json,
 * and pins the top-level `model` to the provider's default model.
 *
 * What settings.json carried before the switch is saved under
 * `workers.fallback.saved` in ~/.config/pai/config.json; `fallback off`
 * restores it exactly and removes the added keys. Both files are written
 * atomically; nothing else in them is touched. While fallback is on the
 * Agent hook keeps routing subagents to workers, unchanged — those runs set
 * their own env per provider and are unaffected.
 *
 * Running Claude Code processes keep the provider they started with until
 * restarted; `fallback status` lists them and points at the note `on` leaves
 * in the workers log dir (FALLBACK-ACTIVE.md).
 *
 * CLAUDE_SETTINGS_PATH overrides the settings.json location (dry runs against
 * a copy); the config path is injectable for tests the same way.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonStrict, writeJsonAtomic } from "../config/json-store.js";
import {
  WorkersConfigError,
  providerKeyPath,
  readWorkersSection,
  resolveModelCapability,
  writeWorkersSection,
  type WorkerProvider,
  type WorkersFallback,
} from "./config.js";
import { resolveTarget } from "./routing.js";
import { workersLogDir } from "./paths.js";

/** settings.json location; CLAUDE_SETTINGS_PATH points it at a copy for dry runs. */
export function fallbackSettingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), ".claude", "settings.json");
}

/** The note `on` writes so a human landing in the log dir sees the switch. */
export function fallbackNotePath(logDir: string): string {
  return join(logDir, "FALLBACK-ACTIVE.md");
}

export interface FallbackPaths {
  /** settings.json to switch (default: fallbackSettingsPath()). */
  settingsPath?: string;
  /** pai config.json holding the workers section (default: the real one). */
  configPath?: string;
}

export interface FallbackOnResult {
  provider: string;
  /** True when fallback was already on for this provider (env re-applied, saved state kept). */
  alreadyOn: boolean;
  /** Env keys written into settings.json. */
  envKeys: string[];
  /** Model the top-level pin was set to. */
  model: string;
}

export interface FallbackOffResult {
  provider: string;
  /** Env keys removed or restored in settings.json. */
  envKeys: string[];
}

/**
 * The env block fallback writes: the provider's endpoint and token, model
 * pins (fast model as haiku, default as sonnet and opus — the same mapping
 * buildRunEnv uses), the provider's own env, and the two fallback constants.
 */
export function fallbackEnv(provider: WorkerProvider): Record<string, string> {
  let token = "local";
  const keyPath = providerKeyPath(provider);
  if (keyPath) {
    token = readFileSync(keyPath, "utf8").trim();
    if (!token) throw new WorkersConfigError(`key file is empty: ${keyPath}`);
  }
  return {
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_DEFAULT_OPUS_MODEL: provider.models.default,
    ANTHROPIC_DEFAULT_SONNET_MODEL: provider.models.default,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: resolveModelCapability(provider, "fast"),
    ...provider.env,
    ENABLE_TOOL_SEARCH: "true",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

function assertFallbackCapable(name: string, p: WorkerProvider): void {
  if (p.protocol === "openai") {
    throw new WorkersConfigError(
      `provider "${name}" speaks the openai protocol and only works through the live PAI proxy — ` +
        `fallback needs an anthropic-protocol provider every process can reach directly.`
    );
  }
  if (p.engine === "codex") {
    throw new WorkersConfigError(
      `provider "${name}" runs through the Codex CLI — fallback switches Claude Code itself and needs a claude-engine provider.`
    );
  }
  if (!p.baseUrl) {
    throw new WorkersConfigError(`provider "${name}" has no baseUrl — fallback cannot point at it.`);
  }
}

/** The env block of a parsed settings.json record, or null when absent. */
function envBlockOf(settings: Record<string, unknown>): Record<string, unknown> | null {
  return typeof settings.env === "object" && settings.env !== null
    ? (settings.env as Record<string, unknown>)
    : null;
}

/** Apply a saved state to a parsed settings.json record (inverse of the switch). */
function restoreSettings(
  settings: Record<string, unknown>,
  saved: WorkersFallback["saved"]
): string[] {
  const keys = Object.keys(saved.env);
  if (saved.envExisted) {
    const env = { ...(typeof settings.env === "object" && settings.env !== null ? (settings.env as Record<string, unknown>) : {}) };
    for (const k of keys) {
      const v = saved.env[k];
      if (v === null) delete env[k];
      else env[k] = v;
    }
    settings.env = env;
  } else {
    delete settings.env;
  }
  if (saved.model === null) delete settings.model;
  else settings.model = saved.model;
  return keys;
}

function writeFallbackNote(logDir: string, r: FallbackOnResult): string {
  const path = fallbackNotePath(logDir);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  writeFileSync(
    path,
    [
      `# Fallback active`,
      ``,
      `- switched: ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`,
      `- provider: ${r.provider} — every NEW Claude Code process on this machine runs on it`,
      `- settings.json: env got ${r.envKeys.join(", ")}; top-level model pinned to ${r.model}`,
      `- turn off: pai worker fallback off (restores settings.json exactly)`,
      ``,
      `## Running sessions`,
      ``,
      `restart this session in its project directory; the new process uses ${r.provider}; keep the same AIBroker name`,
      ``,
    ].join("\n"),
    "utf8"
  );
  return path;
}

/**
 * Switch every new Claude Code process to a worker provider.
 *
 * Write order: the saved state lands in the pai config BEFORE settings.json
 * is touched, so a crash between the two writes leaves `off` able to restore
 * (and `on` re-applies idempotently, healing the gap).
 */
export function fallbackOn(providerFlag: string | undefined, paths: FallbackPaths = {}): FallbackOnResult {
  const settingsPath = paths.settingsPath ?? fallbackSettingsPath();
  const { raw, workers } = readWorkersSection(paths.configPath);
  const logDir = workersLogDir(workers);
  const target = resolveTarget(workers, logDir, { flagProvider: providerFlag });
  const { providerName, provider } = target;
  assertFallbackCapable(providerName, provider);

  const env = fallbackEnv(provider);
  const envKeys = Object.keys(env);
  const settings = readJsonStrict(settingsPath, settingsPath);

  const prev = workers.fallback;
  if (prev && prev.provider === providerName) {
    // Already on for this provider: re-apply (heals a crash between the two
    // writes) but keep the ORIGINAL saved state and stamp — that is what `off`
    // must restore to.
    const eb = envBlockOf(settings);
    settings.env = { ...(eb ?? {}), ...env };
    settings.model = provider.models.default;
    writeJsonAtomic(settingsPath, settings, { label: settingsPath });
    return { provider: providerName, alreadyOn: true, envKeys, model: provider.models.default };
  }
  if (prev) {
    // Switching providers while on: restore what the first switch saved, then
    // save fresh from the restored state.
    restoreSettings(settings, prev.saved);
  }
  const envBlock = envBlockOf(settings);

  const saved: WorkersFallback["saved"] = {
    env: {},
    model: typeof settings.model === "string" ? settings.model : null,
    envExisted: envBlock !== null,
  };
  for (const k of envKeys) {
    saved.env[k] = envBlock && typeof envBlock[k] === "string" ? (envBlock[k] as string) : null;
  }

  workers.fallback = { provider: providerName, saved, on: new Date().toISOString() };
  writeWorkersSection(raw, workers, paths.configPath);

  settings.env = { ...(envBlock ?? {}), ...env };
  settings.model = provider.models.default;
  writeJsonAtomic(settingsPath, settings, { label: settingsPath });

  const r: FallbackOnResult = { provider: providerName, alreadyOn: false, envKeys, model: provider.models.default };
  writeFallbackNote(logDir, r);
  return r;
}

/** Restore settings.json exactly and clear the switch. Errors when not on. */
export function fallbackOff(paths: FallbackPaths = {}): FallbackOffResult {
  const settingsPath = paths.settingsPath ?? fallbackSettingsPath();
  const { raw, workers } = readWorkersSection(paths.configPath);
  const fb = workers.fallback;
  if (!fb) throw new WorkersConfigError("fallback is not on — nothing to restore");

  const settings = readJsonStrict(settingsPath, settingsPath);
  const envKeys = restoreSettings(settings, fb.saved);
  writeJsonAtomic(settingsPath, settings, { label: settingsPath });

  workers.fallback = null;
  writeWorkersSection(raw, workers, paths.configPath);

  try {
    const note = fallbackNotePath(workersLogDir(workers));
    if (existsSync(note)) unlinkSync(note);
  } catch {
    /* the note is advisory; its removal must never fail the restore */
  }
  return { provider: fb.provider, envKeys };
}

export interface FallbackStatus {
  on: boolean;
  provider: string | null;
  /** ISO stamp of the switch, when on. */
  onAt: string | null;
  /** FALLBACK-ACTIVE.md path, when on. */
  notePath: string | null;
  /** Where the running-session list came from. */
  sessionsSource: "aibroker" | "ps";
  /** One line per running Claude Code process/session. */
  sessions: string[];
}

/** Running Claude Code processes: the AIBroker managers registry when it has
 * entries, else `ps`. Informational — sessions keep their provider until
 * restarted whatever this shows. */
export function listClaudeSessions(): { source: "aibroker" | "ps"; lines: string[] } {
  // AIBroker registry (~/.aibroker/managers.json): manager name → session
  // record. Best-effort — any parse problem falls through to ps.
  try {
    const regPath = join(homedir(), ".aibroker", "managers.json");
    if (existsSync(regPath)) {
      const reg = JSON.parse(readFileSync(regPath, "utf8")) as Record<string, unknown>;
      const names = Object.keys(reg);
      if (names.length) {
        const lines = names.map((name) => {
          const rec = typeof reg[name] === "object" && reg[name] !== null ? (reg[name] as Record<string, unknown>) : {};
          const bits = [name];
          for (const field of ["session", "cwd", "pid"] as const) {
            const v = rec[field];
            if (typeof v === "string" || typeof v === "number") bits.push(`${field} ${v}`);
          }
          return bits.join("  ");
        });
        return { source: "aibroker", lines };
      }
    }
  } catch {
    /* fall through to ps */
  }
  try {
    const out = execFileSync("/bin/ps", ["-eo", "pid=,etime=,command="], {
      encoding: "utf8",
      timeout: 10_000,
    });
    // pid, etime, then the command; keep only lines whose command is a
    // `claude` executable (the `cli.js` shape also matches other daemons)
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = l.match(/^\d+\s+\S+\s+(.*)$/);
        return m ? m[1] : "";
      })
      .filter((cmd) => {
        const first = cmd.split(/\s+/)[0] ?? "";
        return first === "claude" || first.endsWith("/claude");
      })
      .map((cmd) => (cmd.length > 100 ? cmd.slice(0, 97) + "…" : cmd))
      .slice(0, 20);
    return { source: "ps", lines };
  } catch {
    return { source: "ps", lines: [] };
  }
}

export function fallbackStatus(paths: FallbackPaths = {}): FallbackStatus {
  const { workers } = readWorkersSection(paths.configPath);
  const fb = workers.fallback;
  const sessions = listClaudeSessions();
  if (!fb) {
    return {
      on: false,
      provider: null,
      onAt: null,
      notePath: null,
      sessionsSource: sessions.source,
      sessions: sessions.lines,
    };
  }
  const notePath = fallbackNotePath(workersLogDir(workers));
  return {
    on: true,
    provider: fb.provider,
    onAt: fb.on,
    notePath,
    sessionsSource: sessions.source,
    sessions: sessions.lines,
  };
}

/** Human-readable status block for the CLI and the MCP tool. */
export function fallbackStatusText(s: FallbackStatus): string[] {
  const lines: string[] = [];
  if (!s.on) {
    lines.push("fallback: off — new Claude Code processes run on the Anthropic login");
    lines.push("turn on with: pai worker fallback on [provider]");
  } else {
    lines.push(`fallback: on — provider ${s.provider} (since ${s.onAt})`);
    lines.push("every NEW Claude Code process runs on it; turn off with: pai worker fallback off");
    if (s.notePath) {
      lines.push(`note: ${s.notePath}${existsSync(s.notePath) ? "" : " (missing)"}`);
    }
  }
  lines.push("");
  lines.push(
    s.sessions.length
      ? `running Claude Code sessions (${s.sessionsSource}; they keep their current provider until restarted):`
      : `no running Claude Code sessions detected (${s.sessionsSource})`
  );
  lines.push(...(s.sessions.length ? s.sessions.map((l) => `  ${l}`) : []));
  return lines;
}
