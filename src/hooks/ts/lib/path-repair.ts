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
import { basename, dirname, isAbsolute } from "node:path";
import { dropHeredocBodies } from "./heredoc.js";

export const MAX_DISTANCE = 3;

/** A repair may reinstate at most this many dropped middle segments of the cwd. */
export const MAX_DROPPED = 2;

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

/**
 * When a path with .js/.mjs/.jsx extension does not exist but a corresponding
 * .ts/.mts/.tsx version exists, return the TS version path.
 * Only applies when the original path itself does not exist.
 */
export function tsSibling(value: string, exists: (p: string) => boolean): string | null {
  if (exists(value)) return null;

  const ext = value.slice(value.lastIndexOf('.'));
  let replacement: string | null = null;

  switch (ext) {
    case '.js':
      replacement = value.slice(0, -3) + '.ts';
      break;
    case '.mjs':
      replacement = value.slice(0, -4) + '.mts';
      break;
    case '.jsx':
      replacement = value.slice(0, -4) + '.tsx';
      break;
    default:
      return null;
  }

  if (exists(replacement)) {
    return replacement;
  }

  return null;
}

export interface PathRepairInput {
  tool_name?: string;
  cwd?: string;
  tool_input?: Record<string, unknown>;
}

export interface PathRepair {
  old: string;
  new: string;
  updatedInput: Record<string, unknown>;
  /** The corrected file does not exist yet (only its folder does): the call cannot succeed, so it is denied. */
  missing?: boolean;
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

  // Rule 1b: the cwd folder name cut short (`P/arm-abc` for `P/arm-abc-spec-1`).
  const realParent = dirname(realish(cwd));
  const parent = canon(realParent);
  const name = basename(cwd.replace(/\/+$/, ""));
  const cv = canon(value);
  if (parent !== "/" && cv.startsWith(`${parent}/`)) {
    const [x, ...rest] = cv.slice(parent.length + 1).split("/");
    if (x && x !== name && name.startsWith(`${x}-`) && !exists(`${realParent}/${x}`) && !exists(`${parent}/${x}`)) {
      const fixed = rest.length ? `${root}/${rest.join("/")}` : root;
      if (exists(probe(fixed))) return fixed;
    }
  }

  // Rule 1c: whole middle segments of the cwd dropped
  // (`…/logs/worktrees/<id>` for cwd `…/logs/workers/worktrees/<id>`).
  // Past the shared prefix, the path resumes on the cwd's tail after the dropped
  // segments; the remainder is appended to the cwd. Shortest candidate first.
  let common = 0;
  while (common < k && common < valParts.length && cwdParts[common] === valParts[common]) common++;
  const cRest = cwdParts.slice(common);
  const pRest = valParts.slice(common);
  const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  for (let dropped = 1; dropped <= MAX_DROPPED && dropped < cRest.length; dropped++) {
    const resume = cRest.length - dropped;
    if (resume > pRest.length) continue;
    if (!eq(pRest.slice(0, resume), cRest.slice(dropped))) continue;
    const rest = pRest.slice(resume);
    const fixed = rest.length ? `${root}/${rest.join("/")}` : root;
    if (exists(probe(fixed))) return fixed;
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
  if (!spec || typeof value !== "string") return null;

  // For relative paths, resolve against cwd first
  const resolvedValue = isAbsolute(value) ? value : join(cwd, value);

  // First try to repair with tsSibling
  const tsFixed = tsSibling(resolvedValue, exists);
  if (tsFixed) {
    const updatedInput = { ...input.tool_input, [spec.key]: tsFixed };
    if (DENY_REPAIR_TOOLS.has(input.tool_name!)) {
      // For Edit, MultiEdit, Write, NotebookEdit, deny with the exact path
      return { old: value, new: tsFixed, updatedInput, missing: true };
    }
    return { old: value, new: tsFixed, updatedInput };
  }

  // If not repaired by tsSibling, proceed with existing logic for absolute paths
  if (!isAbsolute(value)) return null;

  const fixed = repairValue(value, cwd, spec.mustExist, exists);
  if (fixed) return { old: value, new: fixed, updatedInput: { ...input.tool_input, [spec.key]: fixed } };
  // Read/Edit of a file that is not there yet (the unit has not created it): the folder repairs the prefix, the call is denied with the exact path.
  const folder = spec.mustExist && FILE_TOOLS.has(input.tool_name!) ? repairValue(value, cwd, false, exists) : null;
  return folder ? { old: value, new: folder, updatedInput: { ...input.tool_input, [spec.key]: folder }, missing: true } : null;
}

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "NotebookEdit"]);

/** Shell word characters split a command into candidate tokens. */
const WORD = /[^\s;|&<>()`"'$=,:{}]+/g;
const GLOB = /[*?[\]!~]/;
const BASH_ALLOW = ["/dev", "/bin", "/sbin", "/usr", "/System", "/Library", "/opt", "/private/var/folders", "/var/folders", "/Applications"];

/**
 * Program text of `python -c`, `node -e`, `perl -e`, `awk '…'` and the pattern operand of
 * grep/egrep/fgrep/rg/ag (first non-option word, or the value of -e/--regexp; -f/--file name
 * a file, not a pattern): code or a regex, not paths.
 */
const INLINE_PROGRAM = /(\b(?:python[\d.]*|node|ruby|perl|php|bun|deno)\b[^\n;|&]*?\s-[a-zA-Z]*[ceE]\s+|\bawk\s+(?:-\S+\s+)*|\b(?:e|f)?grep\s+(?:-(?!-?[a-zA-Z]*f)\S*\s+)*|\b(?:rg|ag)\s+(?:-(?!-?[a-zA-Z]*f)\S*\s+)*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'\-]\S*)/g;

function absTokens(command: string): string[] {
  return (command.replace(INLINE_PROGRAM, "$1''").match(WORD) ?? []).filter((t) => t.startsWith("/") && !GLOB.test(t));
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

/**
 * Edit-class tools validate the original input before updatedInput applies, so a rewrite cannot help: deny with the exact path.
 * A failed Edit fires no hook at all (measured: no PreToolUse, PostToolUse or PostToolUseFailure),
 * so the repaired Read/Glob/Grep/Bash carries the correct path as context for the edits that follow.
 */
const DENY_REPAIR_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function renderRepair(r: PathRepair, tool?: string): string {
  if (r.missing) return renderDeny(`Wrong path. Use exactly: ${r.new} (it does not exist yet)`);
  if (tool && DENY_REPAIR_TOOLS.has(tool)) return renderDeny(`Wrong path. Use exactly: ${r.new}`);
  const msg = `path repaired: ${r.old} → ${r.new}`;
  const context = `${msg}. ${r.old} does not exist; use exactly ${r.new} in every later Edit, Write and Read.`;
  return JSON.stringify({
    systemMessage: msg,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: r.updatedInput,
      additionalContext: context,
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

/** The arm's own /tmp scratch (commit messages etc.), shared by file tools and Bash; other arms stay fenced. */
function isTmpScratch(v: string, env: NodeJS.ProcessEnv): boolean {
  const under = (p: string, root: string) => p === root || p.startsWith(`${root.replace(/\/+$/, "")}/`);
  return under(v, realish("/tmp")) && !under(v, realish(env.PAI_AB_ARMS_ROOT || "/private/tmp/ab-arms"));
}

/** Reason to deny an absolute path outside the cwd; null = let it through. Only isolated A/B arms are fenced. */
export function denyReason(input: PathRepairInput, env: NodeJS.ProcessEnv): string | null {
  if (env.PAI_WORKER !== "1") return null;
  if (input.tool_name === "Bash") return denyBash(input, env);
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
  if (isTmpScratch(v, env)) return null;
  if (READ_TOOLS.has(input.tool_name!)) {
    const home = env.HOME ? [`${env.HOME}/.claude`, `${env.HOME}/.cache`] : [];
    if ([...READ_ALLOW, ...home].some((r) => under(v, realish(r)))) return null;
  }
  return `Your working directory is ${cwd}. Paths outside it are not part of this task. Use a path relative to ${cwd}. Outside it: ${value}`;
}

/**
 * Normal worker worktrees: a `cd <abs>` whose target is the cwd under a wrong prefix (a dropped or
 * mistyped segment) dies with "no such file or directory" and the run loops; deny with the exact fix.
 */
function cdReason(command: string, cwd: string): string | null {
  for (const m of command.matchAll(/(?:^|[;&|(]\s*)cd\s+(\/[^\s;|&<>()"'`]+)/g)) {
    const target = m[1];
    if (existsSync(target)) continue;
    const fixed = repairValue(target, cwd, true, existsSync);
    if (!fixed) continue;
    const next = command.replace(target, fixed);
    return `Wrong path in cd: ${target}. You are already in your worktree ${cwd}; drop the cd. Corrected command: ${next}`;
  }
  return null;
}

/** Bash: deny a missing absolute-path token outside the arm cwd (existing paths are the model's business). */
function denyBash(input: PathRepairInput, env: NodeJS.ProcessEnv): string | null {
  const cwd = input.cwd;
  const command = input.tool_input?.command;
  if (!cwd || !isAbsolute(cwd) || typeof command !== "string") return null;
  const realCwd = realish(cwd);
  if (!isIsolatedArm(realCwd)) return cdReason(command, cwd);
  const under = (p: string, root: string) => p === root || p.startsWith(`${root.replace(/\/+$/, "")}/`);
  for (const t of absTokens(command)) {
    if (existsSync(t)) continue;
    const v = realish(t);
    if (under(v, realCwd) || isTmpScratch(v, env) || BASH_ALLOW.some((r) => under(v, realish(r)))) continue;
    return `Your working directory is ${cwd}. Paths outside it are not part of this task. Use a path relative to ${cwd}. Outside it: ${t}`;
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
  for (const seg of expandVars(dropHeredocBodies(command)).split(/[;|&\n]+/)) {
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
