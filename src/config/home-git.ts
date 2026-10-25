/**
 * home-git.ts — version PAI's own configuration writes in PAI_HOME when PAI_HOME
 * is a git repository. Never throws: a failed commit costs one stderr line, not the write.
 * Switch: `home.autoCommit` in config.yaml (default true).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { paiHomeDir } from "./pai-home.js";

/** Runtime/telemetry files that never go into the config history, whatever the .gitignore says. */
const NEVER_COMMIT = [/(^|\/)firings\.jsonl/, /\.db(-wal|-shm)?$/, /(^|\/)logs(\/|$)/];

export function isCommittable(relPath: string): boolean {
  return !NEVER_COMMIT.some((re) => re.test(relPath));
}

function autoCommitEnabled(home: string): boolean {
  try {
    const cfg = parse(readFileSync(join(home, "config.yaml"), "utf8")) as { home?: { autoCommit?: unknown } } | null;
    return cfg?.home?.autoCommit !== false;
  } catch {
    return true;
  }
}

function git(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", home, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Commit exactly `paths` (absolute, or relative to PAI_HOME) as `config: <message>`.
 * No-op unless PAI_HOME has a .git, home.autoCommit is not false, and a path is inside the home.
 */
export function commitHomeChange(paths: string[], message: string): void {
  try {
    const home = resolve(paiHomeDir());
    if (!existsSync(join(home, ".git")) || !autoCommitEnabled(home)) return;
    const rel = paths
      .map((p) => relative(home, isAbsolute(p) ? resolve(p) : resolve(home, p)))
      .filter((p) => p !== "" && !p.startsWith("..") && !isAbsolute(p) && isCommittable(p))
      .filter((p) => existsSync(join(home, p)));
    if (!rel.length) return;
    const add = git(home, ["add", "-f", "--", ...rel]);
    if (add.status !== 0) throw new Error(add.stderr.trim() || "git add failed");
    // only the given paths: a dirty index elsewhere is not swept into this commit
    if (git(home, ["diff", "--cached", "--quiet", "--", ...rel]).status === 0) return;
    const c = git(home, ["commit", "-q", "-m", `config: ${message}`, "--", ...rel]);
    if (c.status !== 0) throw new Error(c.stderr.trim() || c.stdout.trim() || "git commit failed");
  } catch (e) {
    process.stderr.write(`pai: home git commit skipped: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** Lines `pai home git-setup` makes sure the PAI_HOME .gitignore has. */
export const GITIGNORE_REQUIRED = ["!/antipatterns/", "/antipatterns/firings.jsonl*"];

/** The .gitignore text with the missing required lines appended (unchanged text when none are missing). */
export function gitignoreWithRequired(text: string): string {
  const have = new Set(text.split("\n").map((l) => l.trim()));
  const missing = GITIGNORE_REQUIRED.filter((l) => !have.has(l));
  if (!missing.length) return text;
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`;
}
