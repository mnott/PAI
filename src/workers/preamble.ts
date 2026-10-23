/**
 * Per-project worker preamble: `.pai/worker.md` at the project root (git
 * toplevel of the cwd; the cwd itself outside git). Its text is appended to the
 * worker's system prompt right after the contract, so a project's standing
 * rules ride on every worker started there.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const PREAMBLE_REL = ".pai/worker.md";
export const PREAMBLE_MAX_BYTES = 16 * 1024;

export interface Preamble {
  path: string;
  text: string;
  lines: number;
  hash: string;
}

export type PreambleResult = { preamble: Preamble | null } | { refused: string };

export function projectRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

/**
 * A gitignored project config file (`.pai/…`): the one under projectRoot(cwd) if it
 * exists, else the main checkout's — a linked worktree has no `.pai/`, so without the
 * fallback its standing rules and checks would vanish there.
 */
export function projectConfigFile(cwd: string, rel: string): string {
  const root = projectRoot(cwd);
  const local = join(root, rel);
  if (existsSync(local)) return local;
  try {
    // the main checkout is the first `git worktree list` entry, and only when it is a normal
    // checkout: dirname(git-common-dir) would hit a shared parent for --separate-git-dir or a bare repo
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = list.split(/\n\s*\n/)[0].split("\n");
    const main = first.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (main && !first.includes("bare") && main !== root) {
      const inMain = join(main, rel);
      if (existsSync(inMain)) return inMain;
    }
  } catch {
    // not a git repo (or an old git without --path-format): the root path stands
  }
  return local;
}

/** Missing or empty file: no preamble. Over PREAMBLE_MAX_BYTES: refused, never truncated. */
export function loadPreamble(cwd: string): PreambleResult {
  const path = projectConfigFile(cwd, PREAMBLE_REL);
  if (!existsSync(path)) return { preamble: null };
  const size = statSync(path).size;
  if (size > PREAMBLE_MAX_BYTES) {
    return { refused: `${path} is ${size} bytes, over the ${PREAMBLE_MAX_BYTES} byte limit — shorten it` };
  }
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return { preamble: null };
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return { preamble: { path, text: text.trim(), lines: text.trimEnd().split("\n").length, hash } };
}

/**
 * The system-prompt block: a fixed header plus the raw file text, nothing run-specific
 * (no ids, paths, hashes), so every worker of a project shares one cacheable prefix.
 */
export function preambleBlock(p: Preamble): string {
  return `## Project worker rules\n\n${p.text}`;
}

export function preambleLine(p: Preamble | null): string {
  return p ? `preamble: ${PREAMBLE_REL} (${p.lines} lines)` : "preamble: none";
}
