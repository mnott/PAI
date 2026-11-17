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
 * An in-place editor (`perl -i`, `sed -i`, `ruby -i`, …) edits its file
 * arguments: existing files are edits and always pass; only a target that
 * does not exist is treated as a new-test write. Unresolvable targets
 * (variables, globs) fail closed; `.pai-scratch/` and the worker's private
 * $TMPDIR pass, a bare /tmp path does not (shared across workers). Heredoc
 * bodies are data, not commands, so the guard reads a `cat > f <<EOF` start
 * line directly rather than scanning the body.
 *
 * First sight of a project without the ignore line: `.pai-scratch/` is added
 * to the repo's `.git/info/exclude` (shared by all its worktrees, never
 * committed). Best effort, never fatal.
 *
 * Pure but for the two filesystem reads (existsSync, the exclude write); the
 * hook entry (pre-tool-use/test-file-governance.ts) only does stdin I/O.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { ensureScratchExcluded, isGitRepo } from "../../../workers/worktree.js";
import { isTestPath as auditIsTestPath } from "../../../testgov/audit.js";
import { parseKept } from "../../../testgov/kept.js";
import { parseCommand } from "./worker-guard.js";
import { blankHeredocBodies } from "./heredoc.js";
import { cwdAfterCds } from "./worker-git-guard.js";
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

/**
 * Outside the governed scope: a path under the eval fixtures (~/.cache/pai/strata-bench) or one that
 * lies in no git repository at all. The rule keeps a repo's suite from growing; a fixture tree or a
 * bare directory has no suite to protect. Absolute paths only; the nearest existing ancestor decides.
 */
export function outsideGovernedRepos(abs: string, home: string = homedir()): boolean {
  if (!abs.startsWith("/")) return false;
  const bench = join(home, ".cache", "pai", "strata-bench");
  if (abs === bench || abs.startsWith(bench + sep)) return true;
  let dir = dirname(abs);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return true;
    dir = parent;
  }
  return !isGitRepo(dir);
}

/** A target whose extension cannot be trusted (variable or glob tail): unknown, fail closed. */
const UNRESOLVABLE = /[$`(){}~]|\*|\?|\[/;

/** True when the (already cwd-resolved) target names a test file we cannot prove exists. */
function looksLikeTest(target: string): boolean {
  if (isScratchPath(target) || isTmpPath(target) || outsideGovernedRepos(target)) return false;
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

/** `-i`, `-pi`, `-ni`, `-i.bak`, `--in-place[=SUFFIX]`: the in-place rewrite flag of perl/sed/ruby. */
const IN_PLACE_FLAG = /^-i(?:[a-z]*|\..+)?$|^--in-place(?:=.*)?$/;

/** True when the segment is an interpreter editing its file arguments in place (`perl|sed|ruby … -i`). */
function inPlaceEditSegment(words: string[]): boolean {
  const cmd = words[0]?.replace(/^.*\//, "");
  return cmd !== undefined && ["perl", "sed", "ruby"].includes(cmd) && words.slice(1).some((w) => IN_PLACE_FLAG.test(w));
}

/** True when a positional of an in-place editor is script text, not a file: `s/x/y/`, `/re/p`, whitespace. */
function looksLikeScriptArg(a: string): boolean {
  if (/\s/.test(a)) return true;
  if (/^[/\\]/.test(a) || /^[a-z]\/[^/]*\//i.test(a)) return true; // /re/, s/x/y/, y/a/b/, \|re\|
  return (a.match(/\//g) ?? []).length >= 2; // a substitution or address with two slashes is code, not a path fragment
}

/**
 * The file arguments of an in-place editor segment: the positionals after the
 * script. Everything up to (and including) the first positional that is not a
 * plausible path — `s/…/…/`, `/re/p`, a value with whitespace — is the script
 * (`perl -i -pe 's/x/y/' f` → `f`; BSD sed's separate backup suffix,
 * `sed -i '' f`, is consumed too). These are the targets of the rewrite — an
 * existing file is an edit (always allowed), only a missing one creates a new
 * test file. A positional that looks like code is never judged as a path.
 */
function inPlaceEditTargets(words: string[]): string[] {
  const args = words.slice(1);
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue;
    if (a.startsWith("-")) {
      // -e/-f scripts take their program as the next word (except bundled `-pe`/`-pi`);
      // a bare `-i` on sed takes its backup suffix as its own argument (`sed -i '' f`)
      const bundled = /^-[a-z]+$/.test(a) && /[ip]/.test(a.slice(1));
      if (a === "-e" || a === "-f" || (/^-[ef]/.test(a) && !bundled)) i++;
      else if (words[0]?.replace(/^.*\//, "") === "sed" && /^-i$/.test(a) && i + 1 < args.length && !args[i + 1].startsWith("-")) i++;
      continue;
    }
    // the first positional that is not a plausible path is the script, not a target
    if (looksLikeScriptArg(a)) continue;
    break;
  }
  return args.slice(i).filter((a) => a !== "--" && !a.startsWith("-"));
}

/** Quoted string literals of `text`, as the shell would pass them. */
function quotedLiterals(text: string): string[] {
  return [...text.matchAll(/(['"])((?:(?!\1)[^\\\n]|\\[\s\S])*)\1/g)].map((m) => m[2].replace(/\\(["'\\])/g, "$1"));
}

/** True when the offset sits inside a quoted region of `text` (not itself a quote). */
function isQuotedAt(text: string, at: number): boolean {
  let quote = "";
  for (let i = 0; i < at; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
  }
  return quote !== "";
}

/**
 * True when a quoted string is code rather than a path: whitespace, regex/
 * substitution syntax (`s/…/…/`, `/re/` — two slashes), `\` escapes or `|`
 * alternation. The interpreter-script heuristic must not read script code as
 * a new test path (AIBroker worker 20261117-013816-67456, denied "No new test
 * files" for `perl -i` edits of three existing test files).
 */
function looksLikeCode(s: string): boolean {
  if (/\s/.test(s)) return true;
  if ((s.match(/\//g) ?? []).length >= 2) return true;
  if (/[$`(){}[\]*?\\|]/.test(s)) return true;
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth !== 0;
}

const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl"]);
/** The inline-code argument of an interpreter segment (`-c`/`-e`/`--eval`/`-p`, perl's bundled `-pe`). */
function inlineCodeArg(args: string[], cmd: string): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    const a = args[i];
    if (a === "--") continue;
    const takesCode = cmd.startsWith("python") ? a === "-c" : cmd === "node" ? ["-e", "--eval", "-p"].includes(a) : a === "-e" || (cmd === "perl" && /^-[a-z]*e$/.test(a));
    if (takesCode) return args[i + 1];
  }
  return null;
}

/** The script texts an interpreter segment runs: inline `-c`/`-e` code, or a /tmp script file's content. */
function interpreterScriptTexts(command: string, readFile: (path: string) => string | null): string[] {
  const out: string[] = [];
  for (const seg of parseCommand(command)) {
    const words = [...seg.words];
    while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || ["nohup", "time", "env", "sudo"].includes(words[0]))) words.shift();
    const [cmd, ...args] = words;
    if (!cmd || !INTERPRETERS.has(cmd)) continue;
    const code = inlineCodeArg(args, cmd);
    if (code !== null) {
      out.push(code);
      continue;
    }
    const script = args.find((a) => !a.startsWith("-"));
    if (script && /^(?:\/private)?\/tmp\//.test(script)) {
      const text = readFile(script);
      if (text !== null) out.push(text);
    }
  }
  return out;
}

/** Why this Bash command creates a new test file outside scratch, or null. */
export function bashCreatesNewTest(command: string, cwd: string): string | null {
  const vars = simpleAssignments(command);
  const consider = (raw: string, at: number): boolean => {
    const t = resolveVars(raw.replace(/^["']|["']$/g, ""), vars);
    if (t.startsWith("&") || t.startsWith("(") || t.startsWith("/dev/")) return false;
    const here = cwdAfterCds(command.slice(0, at), cwd);
    const base = t.startsWith("/") || t.startsWith("$") || t.startsWith("~") ? t : join(here, t);
    if (!looksLikeTest(base)) return false;
    return !promoted(base, here); // a KEPT.md-promoted path is not an unkept new test
  };
  // heredoc bodies are data, not commands: a `cat > f <<EOF` start line writes f
  let pos = 0;
  for (const line of blankHeredocBodies(command).split("\n")) {
    const h = line.match(HEREDOC_START);
    if (h && HEREDOC_SINK.test(line)) {
      const target = /(?<![>&\d])>>?\s*([^\s;&|)]+)/.exec(line)?.[1] ?? /\btee\s+(?:-\w+\s+)*([^\s;&|<>-])/.exec(line)?.[1] ?? /(?<![>&\d])>\s*([^\s;&|)]+)/.exec(line)?.[1];
      if (target && consider(target, pos)) return DENY_TEXT;
    }
    pos += line.length + 1;
  }
  const scan = blankHeredocBodies(command);
  // a quoted script is code, not a redirection: `sed -i 's/a>b/c/' f` and a
  // perl script containing `>` have no sink. The redirect/tee scan runs on the
  // raw text, so blank `<>` inside quoted scripts (offsets preserved) before
  // looking for targets.
  const quotable = scan.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/[<>]/g, " "));
  for (const m of quotable.matchAll(ANY_REDIRECT)) if (consider(m[1], m.index ?? 0)) return DENY_TEXT;
  for (const m of quotable.matchAll(ANY_TEE)) if (consider(m[1], m.index ?? 0)) return DENY_TEXT;
  for (const seg of parseCommand(scan)) {
    const words = [...seg.words];
    // an in-place editor rewrites its file arguments: existing files are edits
    // (always allowed), only a missing target creates a new test file. The
    // segment's own redirects still count (`perl -i -pe … > new.test.ts`).
    if (inPlaceEditSegment(words)) {
      // the file arguments sit after the interpreter word: resolve them with the
      // segment's own cd state (`cd test; sed -i '' f` edits test/f)
      const at = scan.indexOf(words[0]) + words[0].length;
      for (const t of inPlaceEditTargets(words)) if (consider(t, at)) return DENY_TEXT;
    }
    for (const t of toolWriteTargets(words)) if (consider(t, 0)) return DENY_TEXT;
  }
  // an interpreter script (inline -c/-e, or a /tmp script) that writes repo code:
  // it counts as a new-test write when the code names a test path outside scratch.
  // The path candidates are the quoted literals of the script TEXT itself (the
  // command's own quotes are consumed by the shell), resolved against the cwd
  // left by the `cd` segments before the interpreter; a literal that is script
  // code rather than a plausible path (whitespace, substitution syntax) is
  // skipped — reading a `s/…/…/` as a new test path was the false positive.
  const readScript = (p: string): string | null => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  if (scriptWritesRepoCode(command, readScript)) {
    // the interpreter's cwd is the cd state at its own segment: find each
    // interpreter word and resolve with the prefix before it (a quoted `;` in a
    // script does not split segments, so only separators outside quotes count)
    const interpAt = [...command.matchAll(/(?:^|[;&|\n]\s*)(?:env\s+|command\s+|nohup\s+)*(?:[A-Za-z_]\w*=\S*\s+)*(?:\/\S*\/)?(?:python3?|node|ruby|perl)\b/g)]
      .map((m) => m.index ?? 0)
      .filter((i) => !isQuotedAt(command, i));
    for (const text of interpreterScriptTexts(command, readScript)) {
      for (const s of quotedLiterals(text)) {
        if (!(s.includes("/") || /\.\w{1,5}$/.test(s))) continue;
        if (looksLikeCode(s)) continue;
        for (const at of interpAt.length ? interpAt : [0]) if (consider(s, at)) return DENY_TEXT;
      }
    }
  }
  return null;
}

/** The ledger folder as projects spell it: `tests/KEPT.md` or `Tests/KEPT.md` (case-sensitive volumes too). */
const LEDGER_PATHS = [KEPT_LEDGER, join("Tests", "KEPT.md")];

/** True when tests/KEPT.md (project root) names this path or its basename. */
function promoted(abs: string, cwd: string): boolean {
  let dir = resolve(cwd);
  for (;;) {
    const ledger = LEDGER_PATHS.map((p) => join(dir, p)).find((p) => existsSync(p));
    if (ledger) {
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
  if (isScratchPath(abs) || isTmpPath(abs) || outsideGovernedRepos(abs)) return { decision: "allow" };
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
