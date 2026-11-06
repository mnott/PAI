/**
 * spec-paths.ts — spawn-time check of the `spec-paths-missing` anti-pattern: a worker spec that names ./ or ../ paths
 * which do not exist under the worker's cwd. One stderr line before the spawn; in monitor mode nothing is blocked.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { activeAntipattern, fillMessage } from "../hooks/ts/lib/antipatterns.js";
import { dispositionOf } from "../hooks/ts/lib/antipattern-lifecycle.js";
import { recordFiring, type FiringInput } from "../hooks/ts/lib/antipattern-log.js";

const ID = "spec-paths-missing";
const TOKEN = /(?<![\w./~$-])\.{1,2}\/[^\s"'`()<>[\]{},;:]*/g;

/** Distinct ./ and ../ tokens of the prompt, trailing sentence punctuation removed; wildcards, $VARS and <placeholders> skipped. */
export function specPathTokens(prompt: string): string[] {
  const out = new Set<string>();
  for (const m of prompt.matchAll(TOKEN)) {
    const t = m[0].replace(/[.!?]+$/, "");
    if (t === "./" || t === "../" || /[*?$]|\{|</.test(t)) continue;
    out.add(t);
  }
  return [...out];
}

/** The tokens that resolve to nothing under cwd, in order of appearance. */
export function missingSpecPaths(prompt: string, cwd: string): string[] {
  return specPathTokens(prompt).filter((t) => !existsSync(resolve(cwd, t)));
}

/** The warning line, or null when every token exists, there are none, or the pattern is off. Records the firing. */
export function specPathsWarning(prompt: string | null, cwd: string, record: (f: FiringInput) => unknown = recordFiring, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!prompt) return null;
  const missing = missingSpecPaths(prompt, cwd);
  if (!missing.length) return null;
  const ap = activeAntipattern(ID);
  const disp = dispositionOf(ap, prompt, env);
  if (disp === "off") return null;
  record({ id: ap.id, version: ap.version, category: ap.category, action: ap.action, mode: disp, input: missing.join(" "), cwd, env });
  const max = Number(ap.detector.params.max_tokens ?? 3);
  return fillMessage(ap.message, { cwd, tokens: missing.slice(0, max).join(", ") });
}
