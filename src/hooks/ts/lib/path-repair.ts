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

/** The repaired form of one missing absolute path, or null when it exists or cannot be repaired. */
function repairValue(
  value: string,
  cwd: string,
  mustExist: boolean,
  exists: (p: string) => boolean,
): string | null {
  // Write creates the file, so only a missing parent marks a typo.
  const probe = (p: string) => (mustExist ? p : dirname(p));
  if (exists(probe(value))) return null;

  const cwdParts = canon(cwd).split("/").filter(Boolean);
  const valParts = canon(value).split("/").filter(Boolean);
  const k = cwdParts.length;
  const real = cwdParts.join("/");
  const root = cwd.replace(/\/+$/, "");

  // Rule 1: leading components are a near-miss of the cwd.
  if (valParts.length > k) {
    const prefix = valParts.slice(0, k).join("/");
    if (prefix !== real && levenshtein(prefix, real) <= MAX_DISTANCE) {
      const fixed = `${root}/${valParts.slice(k).join("/")}`;
      if (exists(probe(fixed))) return fixed;
    }
  }

  // Rule 2: invented prefix; the first suffix (≥ 2 components) that exists under the cwd.
  if (canon(value).startsWith(`/${real}/`)) return null;
  for (let i = 1; i <= valParts.length - 2; i++) {
    const fixed = `${root}/${valParts.slice(i).join("/")}`;
    if (exists(probe(fixed))) return fixed;
  }
  return null;
}

export function repairPath(
  input: PathRepairInput,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): PathRepair | null {
  if (env.PAI_WORKER !== "1") return null;
  const cwd = input.cwd;
  if (!cwd || !isAbsolute(cwd)) return null;
  if (input.tool_name === "Bash") return repairBash(input, cwd, exists);
  const spec = PATH_KEYS[input.tool_name ?? ""];
  const value = input.tool_input?.[spec?.key ?? ""];
  if (!spec || typeof value !== "string" || !isAbsolute(value)) return null;
  const fixed = repairValue(value, cwd, spec.mustExist, exists);
  return fixed ? { old: value, new: fixed, updatedInput: { ...input.tool_input, [spec.key]: fixed } } : null;
}

/** Shell word characters split a command into candidate tokens. */
const WORD = /[^\s;|&<>()`"'$=,:{}]+/g;
const GLOB = /[*?[\]!~]/;
const BASH_ALLOW = ["/dev", "/bin", "/sbin", "/usr", "/System", "/Library", "/opt", "/private/var/folders", "/var/folders", "/Applications"];

function absTokens(command: string): string[] {
  return (command.match(WORD) ?? []).filter((t) => t.startsWith("/") && !GLOB.test(t));
}

/** Bash inside an isolated arm: repair every missing absolute-path token; null if none, or if one cannot be fixed. */
function repairBash(input: PathRepairInput, cwd: string, exists: (p: string) => boolean): PathRepair | null {
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !isIsolatedArm(realish(cwd))) return null;
  const fixes = new Map<string, string>();
  for (const t of absTokens(command)) {
    if (exists(t) || fixes.has(t)) continue;
    const fixed = repairValue(t, cwd, true, exists);
    if (!fixed) return null;
    fixes.set(t, fixed);
  }
  if (!fixes.size) return null;
  const next = command.replace(WORD, (t) => fixes.get(t) ?? t);
  return {
    old: [...fixes.keys()].join(" "),
    new: [...fixes.values()].join(" "),
    updatedInput: { ...input.tool_input, command: next },
  };
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
  if (input.tool_name === "Bash") return denyBash(input);
  const spec = PATH_KEYS[input.tool_name ?? ""];
  const cwd = input.cwd;
  const value = input.tool_input?.[spec?.key ?? ""];
  if (!spec || !cwd || !isAbsolute(cwd) || typeof value !== "string" || !isAbsolute(value)) return null;

  const realCwd = realish(cwd);
  if (!isIsolatedArm(realCwd)) return null;
  const under = (p: string, root: string) => p === root || p.startsWith(`${root.replace(/\/+$/, "")}/`);
  const v = realish(value);
  if (under(v, realCwd)) return null;
  // The arm's own /tmp scratch (commit messages etc.); other arms stay fenced.
  if (under(v, realish("/tmp")) && !under(v, realish(env.PAI_AB_ARMS_ROOT || "/private/tmp/ab-arms"))) return null;
  if (READ_TOOLS.has(input.tool_name!)) {
    const home = env.HOME ? [`${env.HOME}/.claude`, `${env.HOME}/.cache`] : [];
    if ([...READ_ALLOW, ...home].some((r) => under(v, realish(r)))) return null;
  }
  return `Your working directory is ${cwd}. Paths outside it are not part of this task. Use a path relative to ${cwd}.`;
}

/** Bash: deny a missing absolute-path token outside the arm cwd (existing paths are the model's business). */
function denyBash(input: PathRepairInput): string | null {
  const cwd = input.cwd;
  const command = input.tool_input?.command;
  if (!cwd || !isAbsolute(cwd) || typeof command !== "string") return null;
  const realCwd = realish(cwd);
  if (!isIsolatedArm(realCwd)) return null;
  const under = (p: string, root: string) => p === root || p.startsWith(`${root.replace(/\/+$/, "")}/`);
  for (const t of absTokens(command)) {
    if (existsSync(t)) continue;
    const v = realish(t);
    if (under(v, realCwd) || BASH_ALLOW.some((r) => under(v, realish(r)))) continue;
    return `Your working directory is ${cwd}. Paths outside it are not part of this task. Use a path relative to ${cwd}.`;
  }
  return null;
}

export function renderDeny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}

/** Root holding running A/B arms; overridable so tests never touch the real one. */
const armsRoot = (env: NodeJS.ProcessEnv): string => canon((env.PAI_AB_ARMS_ROOT || "/private/tmp/ab-arms").replace(/\/+$/, ""));

/** Substitute $VAR / ${VAR} from simple NAME=value assignments earlier in the same command line. */
function expandVars(command: string): string {
  const vars = new Map<string, string>();
  for (const m of command.matchAll(/(?:^|[\s;&|])(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|]*)/g)) {
    vars.set(m[1], m[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  let out = command;
  for (let i = 0; i < 3; i++) {
    out = out.replace(/\$(?:\{(\w+)\}|(\w+))/g, (all, a, b) => vars.get(a ?? b) ?? all);
  }
  return out;
}

const DESTRUCTIVE = /(?:^|\s)(?:rm|mv|unlink|shred|truncate)\s|(?:^|\s)rsync\s[^;|&]*--delete|(?:^|\s)git\s(?:-C\s+\S+\s+)?clean\b/;

/** Reason to deny a destructive Bash command aimed at a running A/B arm other than the worker's own; null = fine. */
export function armGuardReason(input: PathRepairInput, env: NodeJS.ProcessEnv): string | null {
  if (env.PAI_WORKER !== "1" || input.tool_name !== "Bash") return null;
  const command = input.tool_input?.command;
  if (typeof command !== "string") return null;
  const root = armsRoot(env);
  const rootRe = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const armRe = new RegExp(`(?:/private)?${rootRe}/([^/\\s"';|&<>)]+)`, "g");
  const cwd = input.cwd && isAbsolute(input.cwd) ? canon(realish(input.cwd)) : "";
  const under = (p: string, r: string) => p === r || p.startsWith(`${r}/`);
  for (const seg of expandVars(command).split(/[;|&\n]+/)) {
    const redirect = [...seg.matchAll(/>>?\s*(\S+)/g)].map((m) => m[1]);
    const targets = DESTRUCTIVE.test(` ${seg}`) ? seg : redirect.join(" ");
    for (const m of targets.matchAll(armRe)) {
      if (!under(cwd, canon(realish(`${root}/${m[1]}`)))) {
        return "this path belongs to a running A/B arm; use your own scratch dir (mktemp -d)";
      }
    }
  }
  return null;
}
