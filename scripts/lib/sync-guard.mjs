/**
 * sync-guard.mjs — the one rule the build --sync steps must respect.
 *
 * `bun run build` from a repository checkout deploys it: ~/.claude symlinks
 * (hooks, statusline, skills) are repointed at the *building* checkout. Run
 * that from inside a per-worker worktree and the live symlinks end up pointing
 * into a directory that `pai worker merge` deletes minutes later — every
 * session loses its hooks and statusline. That happened live on 2026-09-17.
 *
 * So the sync steps refuse to run when the cwd sits under the workers
 * worktrees root, derived from the configured `workers.logDir` (default
 * ~/.claude/logs/workers) — never from a hardcoded home path, so a custom
 * logDir stays covered.
 */

import { readFileSync, realpathSync, existsSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, sep } from "path";
import { parse } from "yaml";

const DEFAULT_LOG_DIR = "~/.claude/logs/workers";

/** Expand a leading ~ (config values are written with `~` to stay portable). */
export function expandHomePath(p) {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return p;
}

/**
 * Resolve PAI_HOME directory: PAI_HOME env var or ~/.claude/pai default.
 */
function paiHomeDir() {
  return process.env.PAI_HOME || join(homedir(), ".claude", "pai");
}

/**
 * The configured workers logDir: `workers.logDir` from the PAI config, or the
 * default. Missing/unreadable config falls back silently — the default is
 * what an unconfigured machine runs on. Reads config.yaml (canonical) if it
 * exists, else config.json, with fallback to legacy paths in the same order
 * as src/daemon/config.ts `paiConfigFilePath()` uses.
 */
export function workersLogDirFromConfig(configPath) {
  const paiHome = paiHomeDir();
  const NEW_CONFIG_JSON = join(paiHome, "config.json");
  const NEW_CONFIG_YAML = join(paiHome, "config.yaml");
  const OLD_CONFIG_FILE = join(homedir(), ".claude", "pai.json");
  const LEGACY_CONFIG_FILE = join(homedir(), ".config", "pai", "config.json");

  const candidates = [NEW_CONFIG_YAML, NEW_CONFIG_JSON, OLD_CONFIG_FILE, LEGACY_CONFIG_FILE];
  const file = configPath ?? candidates.find((f) => existsSync(f));

  if (!file) {
    return expandHomePath(DEFAULT_LOG_DIR);
  }

  try {
    let raw;
    if (file.endsWith(".yaml")) {
      raw = parse(readFileSync(file, "utf8")) ?? {};
    } else {
      raw = JSON.parse(readFileSync(file, "utf8"));
    }
    const logDir = raw?.workers?.logDir;
    if (typeof logDir === "string" && logDir.trim()) return expandHomePath(logDir.trim());
  } catch {
    // no config or parsing failed — default below
  }
  return expandHomePath(DEFAULT_LOG_DIR);
}

/**
 * realpath, with missing tails resolved through their deepest existing
 * ancestor. A plain fallback to the path as given would leave /var/... vs
 * /private/var/... mismatches (a symlinked prefix) comparing unequal.
 */
function real(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return join(cur, ...tail);
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Is `cwd` inside `<logDir>/worktrees/<worker-id>` — i.e. is this build a
 * per-worker worktree whose sync must not touch the live ~/.claude?
 */
export function isInsideWorkerWorktree(cwd, opts = {}) {
  const root = join(
    real(opts.logDir ?? workersLogDirFromConfig(opts.configPath)),
    "worktrees"
  );
  const here = real(cwd);
  return here === root || here.startsWith(root + sep);
}
