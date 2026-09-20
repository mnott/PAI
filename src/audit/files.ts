/**
 * `pai audit tokens files` — token cost of everything injected as static
 * memory: global/project CLAUDE.md files (and their @-imports), the CORE
 * skill, the whisper rules file, and this project's auto-memory index.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { countTokens, TOKEN_ENCODING } from "./tokens.js";
import { whisperRulesPath } from "../config/pai-files.js";
import { encodeDir } from "../cli/utils.js";

export interface FileTokenReading {
  path: string;
  tokens: number;
  missing: boolean;
}

export interface FilesReport {
  encoding: string;
  readings: FileTokenReading[];
  total: number;
}

const SINGLE_FILE_LIMIT = 5000;
const TOTAL_LIMIT = 10000;

/** Resolve one @-import token found in a CLAUDE.md line to an absolute path. */
function resolveImport(token: string, fromDir: string): string {
  if (token.startsWith("~/")) return join(homedir(), token.slice(2));
  if (token.startsWith("/")) return token;
  return resolve(fromDir, token);
}

/**
 * Find every `@path` import in a CLAUDE.md's contents: a line starting with
 * `@`, or containing `@./` or `@~/` anywhere (Claude Code's memory-import
 * syntax allows either position).
 */
function findImports(contents: string, fileDir: string): string[] {
  const found: string[] = [];
  const tokenPattern = /@(~\/[^\s]+|\.\/[^\s]+|\/[^\s]+)/g;
  for (const line of contents.split("\n")) {
    if (!line.startsWith("@") && !line.includes(" @./") && !line.includes("@~/") && !line.includes(" @/")) continue;
    let match: RegExpExecArray | null;
    tokenPattern.lastIndex = 0;
    while ((match = tokenPattern.exec(line))) {
      found.push(resolveImport(match[1], fileDir));
    }
  }
  return found;
}

/** Every parent-directory CLAUDE.md from `startDir` up to (and including) `/`. */
function parentClaudeMdFiles(startDir: string): string[] {
  const found: string[] = [];
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "CLAUDE.md");
    if (existsSync(candidate)) found.push(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/** The default memory set the task describes, plus any @-imports they pull in. */
export function defaultFileSet(cwd: string): string[] {
  const seeds = [
    join(homedir(), ".claude", "CLAUDE.md"),
    join(cwd, "CLAUDE.md"),
    join(cwd, ".claude", "CLAUDE.md"),
    ...parentClaudeMdFiles(dirname(cwd)),
    join(homedir(), ".claude", "Skills", "CORE", "SKILL.md"),
    whisperRulesPath(),
    join(homedir(), ".claude", "projects", encodeDir(cwd), "memory", "MEMORY.md"),
  ];

  const visited = new Set<string>();
  const ordered: string[] = [];
  const queue = [...seeds];
  while (queue.length) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    ordered.push(path);
    if (!existsSync(path)) continue;
    const contents = readFileSync(path, "utf8");
    for (const imported of findImports(contents, dirname(path))) {
      if (!visited.has(imported)) queue.push(imported);
    }
  }
  return ordered;
}

export function readFileTokens(paths: string[]): FileTokenReading[] {
  return paths.map((path) => {
    if (!existsSync(path)) return { path, tokens: 0, missing: true };
    const text = readFileSync(path, "utf8");
    return { path, tokens: countTokens(text), missing: false };
  });
}

export function auditFiles(paths: string[]): FilesReport {
  const readings = readFileTokens(paths);
  const total = readings.reduce((sum, r) => sum + r.tokens, 0);
  return { encoding: TOKEN_ENCODING, readings, total };
}

export { SINGLE_FILE_LIMIT, TOTAL_LIMIT };

// Referenced by the combined report's severity rules.
export function filesFindings(report: FilesReport): { path: string; tokens: number }[] {
  return report.readings.filter((r) => r.tokens > SINGLE_FILE_LIMIT).map((r) => ({ path: r.path, tokens: r.tokens }));
}
