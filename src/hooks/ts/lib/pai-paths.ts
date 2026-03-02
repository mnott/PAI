/**
 * PAI Path Resolution - Single Source of Truth
 *
 * This module provides consistent path resolution across all PAI hooks.
 * It handles PAI_DIR detection whether set explicitly or defaulting to ~/.claude
 *
 * ALSO loads .env file from PAI_DIR so all hooks get environment variables
 * without relying on Claude Code's settings.json injection.
 *
 * Usage in hooks:
 *   import { PAI_DIR, HOOKS_DIR, SKILLS_DIR } from './lib/pai-paths';
 */

import { homedir } from 'os';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';

/**
 * Load .env file and inject into process.env
 * Must run BEFORE PAI_DIR resolution so .env can set PAI_DIR if needed
 */
function loadEnvFile(): void {
  // Check common locations for .env
  const possiblePaths = [
    resolve(process.env.PAI_DIR || '', '.env'),
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

/**
 * Smart PAI_DIR detection with fallback
 * Priority:
 * 1. PAI_DIR environment variable (if set)
 * 2. ~/.claude (standard location)
 */
export const PAI_DIR = process.env.PAI_DIR
  ? resolve(process.env.PAI_DIR)
  : resolve(homedir(), '.claude');

/**
 * Common PAI directories
 */
export const HOOKS_DIR = join(PAI_DIR, 'Hooks');
export const SKILLS_DIR = join(PAI_DIR, 'Skills');
export const AGENTS_DIR = join(PAI_DIR, 'Agents');
export const HISTORY_DIR = join(PAI_DIR, 'History');
export const COMMANDS_DIR = join(PAI_DIR, 'Commands');

/**
 * Validate PAI directory structure on first import
 * This fails fast with a clear error if PAI is misconfigured
 */
function validatePAIStructure(): void {
  if (!existsSync(PAI_DIR)) {
    console.error(`PAI_DIR does not exist: ${PAI_DIR}`);
    console.error(`   Expected ~/.claude or set PAI_DIR environment variable`);
    process.exit(1);
  }

  if (!existsSync(HOOKS_DIR)) {
    console.error(`PAI hooks directory not found: ${HOOKS_DIR}`);
    console.error(`   Your PAI_DIR may be misconfigured`);
    console.error(`   Current PAI_DIR: ${PAI_DIR}`);
    process.exit(1);
  }
}

// Run validation on module import
// This ensures any hook that imports this module will fail fast if paths are wrong
validatePAIStructure();

/**
 * Helper to get history file path with date-based organization
 */
export function getHistoryFilePath(subdir: string, filename: string): string {
  const now = new Date();
  const tz = process.env.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const year = localDate.getFullYear();
  const month = String(localDate.getMonth() + 1).padStart(2, '0');

  return join(HISTORY_DIR, subdir, `${year}-${month}`, filename);
}
