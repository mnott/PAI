/**
 * path-repair.ts — deterministic repair of mistyped absolute paths in worker
 * file-tool calls.
 *
 * Local models retype a long cwd prefix and flip a character
 * (`…-local32-…` for `…-local30-…`), then loop on "File does not exist".
 * The decision: the path is absolute and missing, its leading components are
 * a near-miss of the cwd (≤ MAX_DISTANCE edits in total), and the same
 * remainder exists under the real cwd. Nothing beyond that rule is guessed.
 *
 * Pure apart from the injected `exists`, same split as lib/worker-guard.ts.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const MAX_DISTANCE = 3;

/** Tools whose path argument is repaired, and the input key holding it. */
const PATH_KEYS: Record<string, { key: string; mustExist: boolean }> = {
  Read: { key: "file_path", mustExist: true },
  Edit: { key: "file_path", mustExist: true },
  MultiEdit: { key: "file_path", mustExist: true },
  NotebookEdit: { key: "notebook_path", mustExist: true },
  Write: { key: "file_path", mustExist: false },
  Glob: { key: "path", mustExist: true },
  Grep: { key: "path", mustExist: true },
};

export interface PathRepairInput {
  tool_name?: string;
  cwd?: string;
  tool_input?: Record<string, unknown>;
}

export interface PathRepair {
  old: string;
  new: string;
  updatedInput: Record<string, unknown>;
}

/** macOS: /tmp, /var, /etc are symlinks into /private. */
const canon = (p: string): string => p.replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, "");

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function repairPath(
  input: PathRepairInput,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): PathRepair | null {
  if (env.PAI_WORKER !== "1") return null;
  const spec = PATH_KEYS[input.tool_name ?? ""];
  const cwd = input.cwd;
  const value = input.tool_input?.[spec?.key ?? ""];
  if (!spec || !cwd || !isAbsolute(cwd) || typeof value !== "string" || !isAbsolute(value)) return null;

  // Write creates the file, so only a missing parent marks a typo.
  const probe = (p: string) => (spec.mustExist ? p : dirname(p));
  if (exists(probe(value))) return null;

  const cwdParts = canon(cwd).split("/").filter(Boolean);
  const valParts = canon(value).split("/").filter(Boolean);
  const k = cwdParts.length;
  const real = cwdParts.join("/");
  const root = cwd.replace(/\/+$/, "");
  const done = (fixed: string): PathRepair => ({
    old: value,
    new: fixed,
    updatedInput: { ...input.tool_input, [spec.key]: fixed },
  });

  // Rule 1: leading components are a near-miss of the cwd.
  if (valParts.length > k) {
    const prefix = valParts.slice(0, k).join("/");
    if (prefix !== real && levenshtein(prefix, real) <= MAX_DISTANCE) {
      const fixed = `${root}/${valParts.slice(k).join("/")}`;
      if (exists(probe(fixed))) return done(fixed);
    }
  }

  // Rule 2: invented prefix; the first suffix (≥ 2 components) that exists under the cwd.
  if (canon(value).startsWith(`/${real}/`)) return null;
  for (let i = 1; i <= valParts.length - 2; i++) {
    const fixed = `${root}/${valParts.slice(i).join("/")}`;
    if (exists(probe(fixed))) return done(fixed);
  }
  return null;
}

export function renderRepair(r: PathRepair): string {
  const msg = `path repaired: ${r.old} → ${r.new}`;
  return JSON.stringify({
    systemMessage: msg,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: r.updatedInput,
      additionalContext: msg,
    },
  });
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const READ_ALLOW = ["/usr", "/System", "/Library", "/opt", "/private/var/folders", "/var/folders", "/Applications"];

/** realpath of p, or of its deepest existing ancestor plus the missing rest. */
function realish(p: string): string {
  let head = p;
  let rest = "";
  for (;;) {
    try {
      return join(realpathSync(head), rest);
    } catch {
      const up = dirname(head);
      if (up === head) return p;
      rest = join(basename(head), rest);
      head = up;
    }
  }
}

/** Isolated A/B arm: under /private/tmp/ab-arms/ or a checkout carrying an ab marker. */
function isIsolatedArm(realCwd: string): boolean {
  if (realCwd.startsWith("/private/tmp/ab-arms/")) return true;
  for (let d = realCwd; ; d = dirname(d)) {
    if (existsSync(join(d, ".git", "ab-isolated")) || existsSync(join(d, ".git", "ab-levers"))) return true;
    if (dirname(d) === d) return false;
  }
}

/** Reason to deny an absolute path outside the cwd; null = let it through. Only isolated A/B arms are fenced. */
export function denyReason(input: PathRepairInput, env: NodeJS.ProcessEnv): string | null {
  if (env.PAI_WORKER !== "1") return null;
  const spec = PATH_KEYS[input.tool_name ?? ""];
  const cwd = input.cwd;
  const value = input.tool_input?.[spec?.key ?? ""];
  if (!spec || !cwd || !isAbsolute(cwd) || typeof value !== "string" || !isAbsolute(value)) return null;

  const realCwd = realish(cwd);
  if (!isIsolatedArm(realCwd)) return null;
  const under = (p: string, root: string) => p === root || p.startsWith(`${root.replace(/\/+$/, "")}/`);
  const v = realish(value);
  if (under(v, realCwd)) return null;
  if (READ_TOOLS.has(input.tool_name!)) {
    const home = env.HOME ? [`${env.HOME}/.claude`, `${env.HOME}/.cache`] : [];
    if ([...READ_ALLOW, ...home].some((r) => under(v, realish(r)))) return null;
  }
  return `Your working directory is ${cwd}. Paths outside it are not part of this task. Use a path relative to ${cwd}.`;
}

export function renderDeny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}
