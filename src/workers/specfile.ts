/**
 * specfile.ts — `--spec <path>` reads a worker's prompt from a file (or stdin
 * via `--spec -`) instead of an inline `-p '<prompt>'`, which has repeatedly
 * died on shell quoting for anything long or multi-line.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The path a --spec value resolves to; "-" (stdin) passes through unchanged.
 * A relative path resolves against the invoking process cwd first and only
 * falls back to the target cwd (--cwd) when it does not exist there.
 */
export function resolveSpecPath(spec: string, cwd: string, callerCwd: string = process.cwd()): string {
  if (spec === "-") return "-";
  const first = resolve(callerCwd, spec);
  if (existsSync(first)) return first;
  const second = resolve(cwd, spec);
  return existsSync(second) ? second : first;
}

/** The prompt text a --spec value reads: the file's exact bytes, or stdin's. */
export function readSpecPrompt(spec: string, cwd: string, callerCwd: string = process.cwd()): string {
  if (spec === "-") {
    let content: string;
    try {
      content = readFileSync(0, "utf8");
    } catch (e) {
      throw new Error(`--spec -: could not read stdin: ${(e as Error).message}`);
    }
    if (!content) throw new Error("--spec -: stdin was empty");
    return content;
  }
  const path = resolveSpecPath(spec, cwd, callerCwd);
  if (!existsSync(path)) {
    const tried = [...new Set([resolve(callerCwd, spec), resolve(cwd, spec)])];
    throw new Error(`--spec: file not found: ${tried.join(" or ")}`);
  }
  const content = readFileSync(path, "utf8");
  if (!content) throw new Error(`--spec: file is empty: ${path}`);
  return content;
}
