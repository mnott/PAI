/**
 * test-governance.ts — the decision behind the PreToolUse test-file guard.
 *
 * Tests are governed, not banned: a NEW test file is by default a one-time
 * test and may only be created under `.pai-scratch/` (gitignored, deleted
 * when the worker's worktree goes). Creating one anywhere else is denied
 * unless it is promoted with evidence: an entry in the project's
 * `tests/KEPT.md` ledger naming the file and its evidence (a real bug it
 * guards, a security or destructive-op guard, an external contract).
 * Editing an EXISTING test file is always allowed — a project may still keep
 * a suite; governance only stops the suite from growing without limit.
 *
 * The denial text states exactly that. The same hook fires for every session
 * (user-level settings installed by `pai setup`, matcher Write|Edit|MultiEdit
 * plus Bash) and for OpenCode through the bridge, so it holds in the
 * interactive session too, not only in workers.
 *
 * Bash coverage: a command creating such a file — `>`/`>>`/`tee` targets,
 * `cp`/`mv` destinations, `touch`/`mkdir` targets, or an interpreter script
 * that writes one (python/node/ruby/perl, inline `-c`/`-e` or a /tmp script).
 * Unresolvable targets (variables, globs) fail closed; `.pai-scratch/` and the
 * worker's private $TMPDIR pass, a bare /tmp path does not (shared across
 * workers). Heredoc bodies are data, not commands, so the guard reads a
 * `cat > f <<EOF` start line directly rather than scanning the body.
 *
 * First sight of a project without the ignore line: `.pai-scratch/` is added
 * to the repo's `.git/info/exclude` (shared by all its worktrees, never
 * committed). Best effort, never fatal.
 *
 * Pure but for the two filesystem reads (existsSync, the exclude write); the
 * hook entry (pre-tool-use/test-file-governance.ts) only does stdin I/O.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureScratchExcluded, isGitRepo } from "../../../workers/worktree.js";
import { isTestPath as auditIsTestPath } from "../../../testgov/audit.js";
import { parseKept } from "../../../testgov/kept.js";
import { parseCommand } from "./worker-guard.js";
import { scriptWritesRepoCode } from "./orchestrator-script-writes.js";

export const SCRATCH_DIR = ".pai-scratch";
/** The promotion ledger, at the project root. */
export const KEPT_LEDGER = join("tests", "KEPT.md");

const DENY_TEXT =
  `No new test files (operator rule). One-time checks go under ${SCRATCH_DIR}/ (never committed, removed when the worker lands); ` +
  `a kept test needs an entry in ${KEPT_LEDGER} with its evidence.`;

/** Test-file shapes (names, tests/ dirs, UI targets, snapshot baselines): the audit's classification. */
export function isTestPath(p: string): boolean {
  return auditIsTestPath(p.split(/[\\/]/).filter((s) => s && s !== ".").join("/"));
}

/** True when a path segment of p is the scratch dir. */
export function isScratchPath(p: string): boolean {
  return p.split(/[\\/]/).includes(SCRATCH_DIR);
}

/**
 * True when p is under a temp dir. A bare /tmp path is NOT scratch: it is
 * shared by every concurrent worker, and a one-time test written there can be
 * re-run and committed by another session — only the worker's private
 * $TMPDIR (…/pai-scratch/<id>/…) and .pai-scratch/ count.
 */
export function isTmpPath(p: string): boolean {
  return /\/pai-scratch\/|\/var\/folders\/[^/]+\/[^/]+\/T\/pai-scratch\/|(^|[\\/])\$TMPDIR([\\/]|$)/.test(p);
}

/** A target whose extension cannot be trusted (variable or glob tail): unknown, fail closed. */
const UNRESOLVABLE = /[$`(){}~]|\*|\?|\[/;

/** True when the (already cwd-resolved) target names a test file we cannot prove exists. */
function looksLikeTest(target: string): boolean {
  if (isScratchPath(target) || isTmpPath(target)) return false;
  if (UNRESOLVABLE.test(target)) return isTestPath(target); // unresolvable: fail closed on the literal shape
  return !existsSync(target) && isTestPath(target); // an existing file: an edit, always allowed
}

/** Simple same-command assignments (`D=/tmp/x`) with a literal value, later ones winning. */
function simpleAssignments(command: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of command.matchAll(/(?:^|[;&|(\s])([A-Za-z_]\w*)=(?:"([^"$`]*)"|'([^']*)'|([^\s;&|$`()"']+))(?=\s|;|&|\||$)/g)) {
    vars.set(m[1], m[2] ?? m[3] ?? m[4]);
  }
  return vars;
}

function resolveVars(target: string, vars: Map<string, string>): string {
  return target.replace(/\$(?:\{(\w+)\}|(\w+))/g, (whole, a, b) => vars.get(a ?? b) ?? whole);
}

/** The last literal `cd <dir>` before `index`, or null when none. */
function lastCdBefore(command: string, index: number): string | null {
  let dir: string | null = null;
  for (const cd of command.slice(0, index).matchAll(/(?:^|[;&|\n]\s*)cd\s+("[^"$`]*"|'[^']*'|[^\s;&|$`()"']+)/g)) {
    dir = cd[1].replace(/^["']|["']$/g, "");
  }
  return dir;
}

const ANY_REDIRECT = /(?<![>&\d])>>?\s*([^\s;&|)]+)/g;
const ANY_TEE = /\btee\s+(?:-[a-z]+\s+)*([^\s;&|)]+)/g;
const HEREDOC_START = /(?<!<)<<(?!<)-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_]\w*))/;
const HEREDOC_SINK = /(?<![>&\d])>>?\s*(?!&|\/dev\/)\S|\btee\s+(?:-\w+\s+)*[^\s;&|<>-]/;

/** Targets of one segment's write-side tools: cp/mv destination, touch, mkdir -p paths. */
function toolWriteTargets(words: string[]): string[] {
  const cmd = words[0]?.replace(/^.*\//, "");
  if (cmd === "cp" || cmd === "mv") {
    const args = words.slice(1).filter((w) => !w.startsWith("-"));
    return args.length >= 2 ? [args[args.length - 1]] : [];
  }
  if (cmd === "touch") return words.slice(1).filter((w) => !w.startsWith("-"));
  if (cmd === "mkdir") return words.slice(1).filter((w) => !w.startsWith("-"));
  return [];
}

/** Why this Bash command creates a new test file outside scratch, or null. */
export function bashCreatesNewTest(command: string, cwd: string): string | null {
  const vars = simpleAssignments(command);
  const consider = (raw: string, at: number): boolean => {
    const t = resolveVars(raw.replace(/^["']|["']$/g, ""), vars);
    if (t.startsWith("&") || t.startsWith("(") || t.startsWith("/dev/")) return false;
    const base = t.startsWith("/") || t.startsWith("$") || t.startsWith("~") ? t : join(lastCdBefore(command, at) ?? cwd, t);
    return looksLikeTest(base);
  };
  // heredoc bodies are data, not commands: a `cat > f <<EOF` start line writes f
  let pos = 0;
  for (const line of command.split("\n")) {
    const h = line.match(HEREDOC_START);
    if (h && HEREDOC_SINK.test(line)) {
      const target = /(?<![>&\d])>>?\s*([^\s;&|)]+)/.exec(line)?.[1] ?? /\btee\s+(?:-\w+\s+)*([^\s;&|<>-])/.exec(line)?.[1] ?? /(?<![>&\d])>\s*([^\s;&|)]+)/.exec(line)?.[1];
      if (target && consider(target, pos)) return DENY_TEXT;
    }
    pos += line.length + 1;
  }
  for (const m of command.matchAll(ANY_REDIRECT)) if (consider(m[1], m.index ?? 0)) return DENY_TEXT;
  for (const m of command.matchAll(ANY_TEE)) if (consider(m[1], m.index ?? 0)) return DENY_TEXT;
  for (const seg of parseCommand(command)) {
    for (const t of toolWriteTargets([...seg.words])) if (consider(t, 0)) return DENY_TEXT;
  }
  // an interpreter script (inline -c/-e, or a /tmp script) that writes repo code:
  // it counts as a new-test write when the code names a test path outside scratch
  if (
    scriptWritesRepoCode(command, (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    })
  ) {
    const paths = [...command.matchAll(/['"]([^'"\n]+)['"]/g)]
      .map((m) => m[1])
      .filter((s) => s.includes("/") || /\.\w{1,5}$/.test(s));
    if (paths.some((p) => looksLikeTest(p.startsWith("/") ? p : join(cwd, p)))) return DENY_TEXT;
  }
  return null;
}

/** True when tests/KEPT.md (project root) names this path or its basename. */
function promoted(abs: string, cwd: string): boolean {
  let dir = resolve(cwd);
  for (;;) {
    const ledger = join(dir, KEPT_LEDGER);
    if (existsSync(ledger)) {
      let text = "";
      try {
        text = readFileSync(ledger, "utf8");
      } catch {
        return false;
      }
      const rel = abs.startsWith(dir + "/") ? abs.slice(dir.length + 1) : abs;
      return parseKept(text).some((e) => e.file === rel);
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export interface TestGovernanceInput {
  tool: string;
  /** Absolute, already-resolved target path (Edit/Write/MultiEdit). */
  filePath?: string;
  /** Bash command. */
  command?: string;
  cwd: string;
}

export type TestGovernanceDecision = { decision: "allow" } | { decision: "deny"; reason: string };

/**
 * The decision. New test file outside scratch and not promoted -> deny.
 * Existing files, scratch paths, prose and everything else -> allow.
 * First sight of a git project whose info/exclude lacks the line: add it.
 */
export function decideTestGovernance(input: TestGovernanceInput): TestGovernanceDecision {
  if (input.tool === "Bash") {
    if (!input.command) return { decision: "allow" };
    ensureScratchIgnored(input.cwd);
    const why = bashCreatesNewTest(input.command, resolve(input.cwd));
    return why ? { decision: "deny", reason: why } : { decision: "allow" };
  }
  if (!["Write", "Edit", "MultiEdit"].includes(input.tool)) return { decision: "allow" };
  const abs = input.filePath;
  if (!abs || !isTestPath(abs)) return { decision: "allow" };
  ensureScratchIgnored(input.cwd);
  if (isScratchPath(abs) || isTmpPath(abs)) return { decision: "allow" };
  if (existsSync(abs)) return { decision: "allow" }; // an edit of an existing test file
  if (promoted(abs, input.cwd)) return { decision: "allow" };
  return { decision: "deny", reason: DENY_TEXT };
}

/**
 * `.pai-scratch/` gitignored in every project: on the guard's first sight of
 * a git repo, add the line to the repo's `.git/info/exclude` (idempotent,
 * shared by all worktrees, never committed). Best effort.
 */
export function ensureScratchIgnored(cwd: string): void {
  try {
    if (isGitRepo(cwd)) ensureScratchExcluded(cwd);
  } catch {
    // best effort (ensureScratchExcluded itself never throws)
  }
}
