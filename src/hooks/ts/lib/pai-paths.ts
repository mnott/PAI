/**
 * PAI Path Resolution - Single Source of Truth
 *
 * This module provides consistent path resolution across all PAI hooks.
 *
 * Two different things live here, and they must not be confused:
 *
 * - ADAPTER_DIR (~/.claude by default) is the Claude Code harness adapter —
 *   fixed, hardcoded paths the harness itself loads from (Hooks/, Skills/,
 *   Agents/, Commands/, settings.json, statusline-command.sh,
 *   tab-color-command.sh). It is harness-specific: a future harness would
 *   need its own adapter directory with its own conventions.
 * - PAI_HOME (~/.claude/pai by default — see ../../../config/pai-home.ts) is
 *   where PAI's own state lives: everything hooks WRITE (History/,
 *   agent-sessions.json, session-routing.json, ...) resolves there, with a
 *   fallback to the pre-2026-09-19 ADAPTER_DIR location and a one-time
 *   stderr notice, exactly like every other PAI_HOME file.
 *
 * ALSO loads .env file from ADAPTER_DIR so all hooks get environment
 * variables without relying on Claude Code's settings.json injection.
 *
 * Usage in hooks:
 *   import { ADAPTER_DIR, HOOKS_DIR, SKILLS_DIR, historyDir } from './lib/pai-paths';
 */

import { homedir } from 'os';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  paiHomePath,
  resolvePaiFile,
  migratePaiFile,
  migratePaiDir,
  type MigrateFileResult,
  type MigrateDirResult,
} from '../../../config/pai-home.js';

/**
 * Load .env file and inject into process.env
 * Must run BEFORE ADAPTER_DIR resolution so .env can set ADAPTER_DIR/PAI_DIR if needed
 */
function loadEnvFile(): void {
  // Check common locations for .env
  const possiblePaths = [
    resolve(process.env.ADAPTER_DIR || process.env.PAI_DIR || '', '.env'),
    resolve(homedir(), '.claude', '.env'),
  ];

  for (const envPath of possiblePaths) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          // Skip comments and empty lines
          if (!trimmed || trimmed.startsWith('#')) continue;

          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1).trim();

            // Remove surrounding quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }

            // Expand $HOME and ~ in values
            value = value.replace(/\$HOME/g, homedir());
            value = value.replace(/^~(?=\/|$)/, homedir());

            // Only set if not already defined (env vars take precedence)
            if (process.env[key] === undefined) {
              process.env[key] = value;
            }
          }
        }
        // Found and loaded, don't check other paths
        break;
      } catch {
        // Silently continue if .env can't be read
      }
    }
  }
}

// Load .env FIRST, before any other initialization
loadEnvFile();

function defaultAdapterDir(): string {
  return resolve(homedir(), '.claude');
}

/**
 * Never print when stdout/stderr is a data channel, not a human: hook
 * bundles and worker-status-line.mjs set PAI_QUIET_NOTICES=1 via their
 * esbuild banner (scripts/build-hooks.mjs), and a `pai worker run
 * --output-format json` invocation is detected directly off argv since its
 * env can't be set before this module's static imports resolve.
 */
function suppressDeprecationNotices(): boolean {
  if (process.env.PAI_QUIET_NOTICES === '1') return true;
  const idx = process.argv.indexOf('--output-format');
  return idx !== -1 && process.argv[idx + 1] === 'json';
}

/**
 * At most once per process — a `globalThis` flag rather than a module-level
 * `let` because hooks and the CLI can end up with more than one instance of
 * this module loaded into the same process (separate bundles), each with its
 * own module scope; only a property on the shared global survives that.
 */
function warnPaiDirDeprecatedOnce(message: string): void {
  const g = globalThis as typeof globalThis & { __paiDirNoticePrinted?: boolean };
  if (g.__paiDirNoticePrinted || suppressDeprecationNotices()) return;
  g.__paiDirNoticePrinted = true;
  process.stderr.write(`pai: ${message}\n`);
}

/**
 * Smart ADAPTER_DIR detection with fallback
 * Priority:
 * 1. ADAPTER_DIR environment variable (if set) — warns once if PAI_DIR is
 *    ALSO set and resolves to a different path (naming both).
 * 2. PAI_DIR environment variable (deprecated alias, one release) — warns
 *    once only when it differs from the default adapter root; PAI_DIR set to
 *    the same value as the default is the operator's current, correct
 *    setting and stays silent.
 * 3. ~/.claude (standard location)
 */
function resolveAdapterDir(): string {
  if (process.env.ADAPTER_DIR) {
    const adapterDir = resolve(process.env.ADAPTER_DIR);
    if (process.env.PAI_DIR) {
      const paiDir = resolve(process.env.PAI_DIR);
      if (paiDir !== adapterDir) {
        warnPaiDirDeprecatedOnce(
          `ADAPTER_DIR (${adapterDir}) and PAI_DIR (${paiDir}) are both set and differ — ADAPTER_DIR wins. PAI_DIR still works for one release.`
        );
      }
    }
    return adapterDir;
  }
  if (process.env.PAI_DIR) {
    const paiDir = resolve(process.env.PAI_DIR);
    if (paiDir !== defaultAdapterDir()) {
      warnPaiDirDeprecatedOnce(
        'PAI_DIR is deprecated — use ADAPTER_DIR for the harness adapter root (~/.claude). PAI_DIR still works for one release.'
      );
    }
    return paiDir;
  }
  return defaultAdapterDir();
}

/** The Claude Code harness adapter root — NOT PAI's state home. See module doc above. */
export const ADAPTER_DIR = resolveAdapterDir();

/** @deprecated alias for ADAPTER_DIR, kept for one release. Prefer ADAPTER_DIR. */
export const PAI_DIR = ADAPTER_DIR;

/**
 * Adapter directories — fixed paths the Claude Code harness itself loads
 * from. These stay under ADAPTER_DIR; they are not PAI state.
 */
export const HOOKS_DIR = join(ADAPTER_DIR, 'Hooks');
export const SKILLS_DIR = join(ADAPTER_DIR, 'Skills');
export const AGENTS_DIR = join(ADAPTER_DIR, 'Agents');
export const COMMANDS_DIR = join(ADAPTER_DIR, 'Commands');

/**
 * Validate PAI directory structure on first import
 * This fails fast with a clear error if PAI is misconfigured
 */
function validatePAIStructure(): void {
  if (!existsSync(ADAPTER_DIR)) {
    console.error(`ADAPTER_DIR does not exist: ${ADAPTER_DIR}`);
    console.error(`   Expected ~/.claude or set ADAPTER_DIR environment variable`);
    process.exit(1);
  }

  if (!existsSync(HOOKS_DIR)) {
    console.error(`PAI hooks directory not found: ${HOOKS_DIR}`);
    console.error(`   Your ADAPTER_DIR may be misconfigured`);
    console.error(`   Current ADAPTER_DIR: ${ADAPTER_DIR}`);
    process.exit(1);
  }
}

// Run validation on module import
// This ensures any hook that imports this module will fail fast if paths are wrong
validatePAIStructure();

// ---------------------------------------------------------------------------
// PAI state written by hooks — resolves under PAI_HOME, falling back to the
// pre-2026-09-19 ADAPTER_DIR location (one-time stderr notice) until
// `pai config migrate --history` moves it. Actively written on every hook
// event across every session, so unlike most PAI_HOME files the live move is
// deliberately NOT automatic — see `pai config migrate --history`.
// ---------------------------------------------------------------------------

function oldHistoryDir(): string {
  return join(ADAPTER_DIR, 'History');
}

/** Read/write location for hook-captured history: PAI_HOME/History if
 *  present, else the old ADAPTER_DIR/History (one-time stderr notice). */
export function historyDir(): string {
  return resolvePaiFile(paiHomePath('History'), [oldHistoryDir()], 'pai config migrate --history');
}

export function migrateHistoryDir(opts: { dryRun?: boolean } = {}): MigrateDirResult {
  return migratePaiDir(paiHomePath('History'), [oldHistoryDir()], opts);
}

function oldAgentSessionsPath(): string {
  return join(ADAPTER_DIR, 'agent-sessions.json');
}

export function agentSessionsPath(): string {
  return resolvePaiFile(paiHomePath('agent-sessions.json'), [oldAgentSessionsPath()], 'pai config migrate --history');
}

export function migrateAgentSessions(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath('agent-sessions.json'), [oldAgentSessionsPath()], opts);
}

function oldSecurityEventsPath(): string {
  return join(ADAPTER_DIR, 'history', 'security', 'security-events.jsonl');
}

export function securityEventsPath(): string {
  return resolvePaiFile(
    paiHomePath('History', 'security', 'security-events.jsonl'),
    [oldSecurityEventsPath()],
    'pai config migrate --history'
  );
}

export function migrateSecurityEvents(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath('History', 'security', 'security-events.jsonl'), [oldSecurityEventsPath()], opts);
}

function oldSessionRoutingPath(): string {
  return join(ADAPTER_DIR, 'session-routing.json');
}

export function sessionRoutingPath(): string {
  return resolvePaiFile(paiHomePath('session-routing.json'), [oldSessionRoutingPath()], 'pai config migrate --history');
}

export function migrateSessionRouting(opts: { dryRun?: boolean } = {}): MigrateFileResult {
  return migratePaiFile(paiHomePath('session-routing.json'), [oldSessionRoutingPath()], opts);
}

/**
 * Helper to get history file path with date-based organization
 */
export function getHistoryFilePath(subdir: string, filename: string): string {
  const now = new Date();
  const tz = process.env.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const year = localDate.getFullYear();
  const month = String(localDate.getMonth() + 1).padStart(2, '0');

  return join(historyDir(), subdir, `${year}-${month}`, filename);
}
