/**
 * spec-paths.ts — spawn-time check of the `spec-paths-missing` anti-pattern: a worker spec that names ./ or ../ paths
 * which do not exist under the worker's cwd. One stderr line before the spawn; in monitor mode nothing is blocked.
 * Only bare path mentions count: a path inside a backtick span, a quoted example command or a test input named as
 * one ("deny …", "allow …", "e.g.") describes an example, not a file the task needs (2026-11-17: a reroute was
 * refused over `./mytool` appearing only inside `allow \`lldb --batch -o "image list" ./mytool\``). A restart never
 * refuses on this check — the origin already started with the same spec — it only warns.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { activeAntipattern, fillMessage } from "../hooks/ts/lib/antipatterns.js";
import { dispositionOf } from "../hooks/ts/lib/antipattern-lifecycle.js";
import { recordFiring, type FiringInput } from "../hooks/ts/lib/antipattern-log.js";

const ID = "spec-paths-missing";
const TOKEN = /(?<![\w./~$-])\.{1,2}\/[^\s"'`()<>[\]{},;:]*/g;
/** Regions of the prompt that name examples, not required paths: backtick spans, quoted example commands, and lines introduced as test inputs ("deny …", "allow …", "e.g.", "for example"). */
const EXAMPLE = /`[^`]*`|(?:"[^"\n]*"|'[^'\n]*'|“[^”]*”)|^[^\n]*(?:\b(?:deny|allow|for example)\b|\be\.g\.)[^\n]*$/gim;

/** Distinct ./ and ../ tokens of the prompt, trailing sentence punctuation removed; wildcards, $VARS and <placeholders> skipped. Tokens inside example spans, quoted commands and test inputs are not required paths. */
export function specPathTokens(prompt: string): string[] {
  const out = new Set<string>();
  for (const m of maskExamples(prompt).matchAll(TOKEN)) {
    const t = m[0].replace(/[.!?]+$/, "");
    if (t === "./" || t === "../" || /[*?$]|\{|</.test(t)) continue;
    out.add(t);
  }
  return [...out];
}

/** The prompt with every example region blanked: backtick spans, quoted strings and whole lines naming a test input ("deny …", "allow …", "e.g.", "for example"). */
function maskExamples(prompt: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  return prompt.replace(EXAMPLE, (m) => blank(m));
}

/** The tokens that resolve to nothing under cwd, in order of appearance. */
export function missingSpecPaths(prompt: string, cwd: string): string[] {
  return specPathTokens(prompt).filter((t) => !existsSync(resolve(cwd, t)));
}

/** True when this start is a reroute/escalation restart: the old run's id travels in PAI_RERUN_OF, its file (a --detach starter), or the waiting reroute's announce file. */
export function isRestartStart(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PAI_RERUN_OF) return true;
  if (env.PAI_RERUN_ID_FILE) return true;
  const f = env.PAI_RERUN_OF_FILE;
  if (!f) return false;
  try {
    return existsSync(f);
  } catch {
    return false;
  }
}

/** The warning line, or null when every token exists, there are none, or the pattern is off. Records the firing. A restart never refuses: it gets a warn line at most (the origin already started with this spec). */
export function specPathsWarning(prompt: string | null, cwd: string, record: (f: FiringInput) => unknown = recordFiring, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!prompt) return null;
  const missing = missingSpecPaths(prompt, cwd);
  if (!missing.length) return null;
  const ap = activeAntipattern(ID);
  const disp = dispositionOf(ap, prompt, env);
  if (disp === "off") return null;
  record({ id: ap.id, version: ap.version, category: ap.category, action: ap.action, mode: disp, input: missing.join(" "), cwd, env });
  const max = Number(ap.detector.params.max_tokens ?? 3);
  const line = fillMessage(ap.message, { cwd, tokens: missing.slice(0, max).join(", ") });
  if (isRestartStart(env)) return `warn: restart keeps its spec as-is (the origin started with it): ${line}`;
  return line;
}
