/**
 * specfile.ts — `--spec <path>` reads a worker's prompt from a file (or stdin
 * via `--spec -`) instead of an inline `-p '<prompt>'`, which has repeatedly
 * died on shell quoting for anything long or multi-line.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The path a --spec value resolves to for display/recording; "-" (stdin) passes through unchanged. */
export function resolveSpecPath(spec: string, cwd: string): string {
  return spec === "-" ? "-" : resolve(cwd, spec);
}

/** The prompt text a --spec value reads: the file's exact bytes, or stdin's. */
export function readSpecPrompt(spec: string, cwd: string): string {
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
  const path = resolveSpecPath(spec, cwd);
  if (!existsSync(path)) throw new Error(`--spec: file not found: ${path}`);
  const content = readFileSync(path, "utf8");
  if (!content) throw new Error(`--spec: file is empty: ${path}`);
  return content;
}
