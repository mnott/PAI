/**
 * worker-guard.ts — the decision behind the worker-only PreToolUse guard.
 *
 * Pure but for reading a `git commit -F <file>` message: no stdin, no git — the hook entry (pre-tool-use/worker-guard.ts)
 * gathers the context, this module decides, same split as sleep-poll-gate.ts.
 * Spec prose ("never symlink node_modules", "do not push", ...) was broken by
 * workers anyway; this is the enforcement. Active only for PAI_WORKER=1.
 *
 * Parsing is conservative on purpose: a command is split on ; && || | & and
 * newlines outside quotes, `bash -c '<cmd>'` is unwrapped, `cd` is tracked
 * across segments. A `)` (or closing backtick) that ends a `$(…)` / backtick
 * substitution or a `( … )` subshell closes the group instead of sticking to
 * the last word: `cat f 2>/dev/null)` inside `$( … )` is read as `/dev/null`,
 * not `/dev/null)` (2026-11-25: that trailing paren made a redirect target
 * outside the worktree, and the worker was denied its own wait recipe).
 * Not caught (false negatives chosen over blocking real
 * work): substitution/subshell bodies are not re-parsed as separate commands
 * (a `>` inside them is still a write target of the whole segment), variables
 * other than ~ and $HOME in paths, scripts that do the forbidden thing
 * internally, `git -C <other>` targeting another repo's cwd, cp/rsync with
 * -t or a source that is a subdirectory of the tree.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { livePaiHomeDirs } from "../../../config/pai-home.js";
import { type GateDecision } from "./render-decision.js";
import { decideWorkerGitGuard, isPrivateClone } from "./worker-git-guard.js";
import { isBrowserTool } from "../../../workers/browser-tools.js";
import { totalSleepSecs } from "../../../workers/status.js";
import { WAIT_RECIPE } from "../../../workers/wait-on.js";
import { forceAddReason, maskedProofReason, tmpScratchReason, nodeOnTypeScriptReason, tscFileArgReason, dbWriteReason, liveContainerReason, type DbWriteAllow } from "./worker-bash-rules.js";
import { operatorTestsReason, projectTestsByOperator } from "./worker-test-rules.js";
import { blankHeredocBodies } from "./heredoc.js";
import { isScratchRootFile } from "./worker-scratch-name.js";
import { browserAutomationBashReason, browserAutomationEditReason, addedText } from "./browser-automation-gate.js";
import { chromeStartReason } from "./worker-chrome-rules.js";
import { benchStartReason } from "./worker-bench-rules.js";
import { raiseWaitTimeout } from "./wait-timeout.js";
import { operatorNamesValue } from "./delegation-gate.js";
import { PAUSE_DENY, preemptDeny, readPauseState, workerPaused } from "../../../workers/pane-bar.js";
import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import { currentWorkerId } from "../../../workers/worker-id.js";

export interface WorkerGuardInput {
  tool_name?: string;
  cwd?: string;
  tool_input?: { command?: string; file_path?: string; path?: string; notebook_path?: string; content?: string; timeout?: number };
}

export interface WorkerGuardContext {
  /** Hook cwd. */
  cwd: string;
  home: string;
  /** Top level of the git tree containing cwd, null outside git. */
  worktreeRoot: string | null;
  /** True when cwd is a linked worktree (git-dir differs from common dir). */
  inWorktree: boolean;
  /** The main checkout the worktree hangs off; null when not in a worktree. */
  mainCheckout: string | null;
  /** Whether a non-worktree cwd is a checkout others share; absent = assume shared. */
  sharedCheckout?: () => boolean;
  /** package.json `scripts.test` of the tree, null when unknown. */
  testScript: () => string | null;
  /** Whether git ignores this path (git check-ignore) as seen from `dir` (where the command runs); absent = nothing is ignored. */
  isIgnored?: (path: string, dir: string) => boolean;
  /** The worker's scratch roots (env TMPDIR, <tmp>/pai-scratch/*); absent = the defaults from env.TMPDIR. */
  scratchDirs?: string[];
  /** The operator's go for benchmarks and model servers (env PAI_BENCH_GO=1). */
  benchGo?: boolean;
  /** Whether a command runs a test runner or a door in test mode (worker-test-rules.ts); the caller reads the project's doors. */
  testCommand?: (command: string) => string | null;
  /** This worker's own task text (its brief), for the child-routing rule; absent = unreadable, which denies an override. */
  taskText?: () => string | undefined;
  /** workers `guard.dbWriteAllow` allowlist for the live-database write rule; absent = defaults (`*_test`, `*_scratch` dbs, no containers). */
  dbWriteAllow?: DbWriteAllow;
  /** workers `guard.liveContainers` globs (config.yaml); absent = none. */
  liveContainers?: string[];
}

interface Segment {
  words: string[];
  /** Redirection targets (`> f`, `>> f`, `2>f`). */
  redirects: string[];
  /** Offsets of this segment's text in blankHeredocBodies(command), which parseCommand ran on: a rule that rewrites the command splices by these (the blanking preserves offsets). */
  start: number;
  end: number;
}

const deny = (reason: string): GateDecision => ({ decision: "deny", reason });
const ALLOW: GateDecision = { decision: "allow" };

/**
 * Sit still while a preemption pause holds the worker, polling its status file, up to `maxMs` (the hook
 * process is killed past ~120 s, so callers pass one Bash timeout). True when it waited at all; false
 * when it gave up early or slept nothing. Sync on purpose: this runs inside a PreToolUse hook.
 */
export function waitWhilePreempted(logDir: string, wid: string, maxMs: number, pollMs = 250): boolean {
  if (maxMs <= 0 || !workerPaused(logDir, wid)) return false;
  const nap = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    nap(pollMs);
    if (!workerPaused(logDir, wid)) break;
  }
  return true;
}

/** Split into segments; quotes group words, operators outside quotes split. Heredoc bodies are blanked first (blankHeredocBodies) — their text is data, not commands — while the start line and everything after a terminator stay at their offsets. */
export function parseCommand(raw: string): Segment[] {
  const command = blankHeredocBodies(raw);
  const segs: Segment[] = [];
  let seg: Segment = { words: [], redirects: [], start: 0, end: 0 };
  let segStart = 0; // offset in `command` where the next segment's text begins
  let tok = "";
  let has = false; // a token is in progress (covers empty quoted "")
  let quote: string | null = null;
  let target: "redir" | "skip" | null = null;
  /** Open groups outside quotes: `$(…`, backtick, `( …`. A closing `)` / backtick at depth > 0 is a delimiter (see below), not part of the word. */
  let depth = 0;

  const flushTok = (): void => {
    if (!has) return;
    if (target === "redir") seg.redirects.push(tok);
    else if (target !== "skip") seg.words.push(tok);
    target = null;
    tok = "";
    has = false;
  };
  const endSeg = (upto: number): void => {
    flushTok();
    if (seg.words.length || seg.redirects.length) segs.push({ ...seg, start: segStart, end: upto });
    seg = { words: [], redirects: [], start: 0, end: 0 };
    segStart = upto;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) tok += command[++i];
      else tok += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (!has && !seg.words.length && !seg.redirects.length) segStart = i; // a quoted word opening at the head of a segment
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      if (!has && !seg.words.length && !seg.redirects.length) segStart = i;
      tok += command[++i];
      has = true;
    } else if (/\s/.test(ch) && ch !== "\n") {
      flushTok();
    } else if (depth > 0 && (ch === ")" || ch === "`")) {
      // the closing delimiter of a `$(…)` / backtick substitution or `( … )` subshell: it ends the group, so it is never part of the preceding word — and a redirect target read inside the group (`cat f 2>/dev/null)`) resolves as `/dev/null`, not `/dev/null)`
      flushTok();
      depth--;
    } else if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      if (ch === "&" && command[i + 1] === ">") continue; // `&>` redirects
      endSeg(i);
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
      segStart = i + 1;
    } else if (ch === ">" || ch === "<") {
      if (has && /^\d+$/.test(tok)) {
        tok = "";
        has = false;
      } else flushTok();
      if (ch === ">" && command[i + 1] === ">") i++;
      if (command[i + 1] === "&") {
        i++;
        target = "skip"; // fd duplication: `2>&1`
      } else target = ch === ">" ? "redir" : "skip";
    } else {
      if (ch === "`") depth++; // an open backtick substitution
      else if (ch === "(") {
        // `$(…` opens a command substitution; a bare `( … )` is a subshell. `(` inside a word (`xargs(`, a function name) stays part of the word.
        // `$(…` opens a substitution even mid-word (`x $(cat …)`); a bare `(` only opens a subshell at the head of a word.
        const opened = tok === "$" || (depth === 0 && !has);
        if (opened) {
          if (tok === "$") {
            // `$(…` consumed as one unit: drop the `$` that was collected before it
            tok = "";
            has = false;
          }
          depth++;
          continue;
        }
      }
      if (!has && !seg.words.length && !seg.redirects.length) segStart = i; // an unquoted word opening at the head of a segment
      tok += ch;
      has = true;
    }
  }
  endSeg(command.length);
  return segs;
}

const REV_LIKE = /^(HEAD|FETCH_HEAD|ORIG_HEAD|[0-9a-f]{7,40})$|[~^@]|^refs\/tags\//;

/** `git switch --detach` / `git checkout --detach|<rev>` (no pathspec): leaves HEAD off the worker's branch. */
function detachesHead(g: { sub: string; rest: string[] }): boolean {
  if (g.sub !== "switch" && g.sub !== "checkout") return false;
  if (g.rest.includes("--detach") || (g.sub === "switch" && g.rest.includes("-d"))) return true;
  if (g.sub !== "checkout" || g.rest.includes("--")) return false;
  if (g.rest.some((a) => /^-[bB]$|^--orphan$/.test(a))) return false;
  const pos = g.rest.filter((a) => !isFlag(a));
  return pos.length > 0 && REV_LIKE.test(pos[0]);
}

const WRAPPERS = new Set(["sudo", "command", "env", "time", "nohup", "exec", "builtin"]);

const CONTROL_WORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "(", "xargs"]);

/** `$(git`, `(git`, `{git`, backtick-git and `/usr/bin/git` all name the command `git`. */
function bareCommand(w: string): string {
  const t = w.replace(/^(\$\(|[({`])+/, "");
  return t.includes("/") && !t.startsWith("-") ? t.slice(t.lastIndexOf("/") + 1) : t;
}

/** The trailing `)` that closes a `$(…` opened inside the segment (an unquoted command substitution): `sed -n "$(grep …),+8p" f` splits at the inner `|`, so without this every later rule misses the command. */
function stripSubClose(words: string[]): string[] {
  let opens = 0;
  for (const w of words) {
    const s = w.replace(/\\[$(`]/g, ""); // an escaped $ ( "…\$…" ) does not open
    for (const m of s.matchAll(/\$\(|[(`]/g)) void m, opens++;
    for (let i = 0; i < s.length; i++) if (s[i] === ")") opens--;
  }
  if (opens <= 0 || words.length === 0) return words;
  const out = [...words];
  const last = out[out.length - 1].replace(/\)+$/, "");
  if (last) out[out.length - 1] = last;
  else out.pop();
  return out;
}

/** Drop env assignments, wrapper commands, control keywords and xargs flags from the front. */
function stripPrefix(words: string[]): string[] {
  const out = stripSubClose([...words]);
  while (out.length) {
    const w = bareCommand(out[0]);
    if (/^[A-Za-z_]\w*=/.test(w) || WRAPPERS.has(w) || CONTROL_WORDS.has(w) || w === "") {
      const wasXargs = w === "xargs";
      out.shift();
      if (wasXargs) {
        while (out.length && isFlag(out[0])) {
          const f = out.shift()!;
          if (/^-[IiLnPsEd]$/.test(f)) out.shift(); // flag with a separate value
        }
      }
      continue;
    }
    out[0] = w;
    break;
  }
  if (out.length) out[out.length - 1] = out[out.length - 1].replace(/[)`]+$/, "") || out[out.length - 1];
  return out;
}

const isFlag = (w: string): boolean => w.startsWith("-") && w.length > 1;

export const WORKER_CHILD_ROUTE_REASON =
  "children follow the mode chain and wait for their slot; --model/--provider only when your brief names it; priority is the operator's call";

/** Values of --model / --provider after `pai worker run|resume` in the segment (`--model X`, `--model=X`, quoted). */
function childOverrides(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++; // leading env assignments retarget the command
  if (!(words[i] === "pai" || bareCommand(words[i] ?? "") === "pai")) return out;
  if (!(words[i + 1] === "worker" && (words[i + 2] === "run" || words[i + 2] === "resume"))) return out;
  for (let j = i + 3; j < words.length; j++) {
    const eq = /^(?:--model|--provider)=(.*)$/.exec(words[j]);
    if (eq) { if (eq[1]) out.push(eq[1]); continue; }
    if (/^--(?:model|provider)$/.test(words[j])) {
      const v = words[j + 1];
      if (v !== undefined && !v.startsWith("-")) { out.push(v); j++; }
      else out.push(""); // a missing or flag-shaped value: nothing is named, deny
    }
  }
  return out;
}

/**
 * The worker child-routing rule: `pai worker run|resume` with --model/--provider is denied unless the
 * worker's own brief names that model/provider (operatorNamesValue, as L0). An unreadable brief denies.
 * `pai worker help` (the budgeted stronger-model call) and every other command pass.
 */
export function childRouteReason(command: string, taskText: string | undefined): string | null {
  const text = blankHeredocBodies(command);
  if (!/pai\s+worker\s+(?:run|resume)/.test(text)) return null;
  for (const seg of parseCommand(command)) {
    const overrides = childOverrides(seg.words);
    if (!overrides.length) continue;
    if (overrides.some((v) => !operatorNamesValue(taskText, v))) return WORKER_CHILD_ROUTE_REASON;
  }
  return null;
}

function expand(p: string, home: string): string {
  return p.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

const hasUnresolvedVar = (p: string): boolean => /[$`]/.test(p);

const isInside = (p: string, root: string): boolean => p === root || p.startsWith(root.replace(/\/$/, "") + "/");

/** Absolute, or null when the path holds variables we cannot resolve. */
function abs(p: string, cwd: string, home: string): string | null {
  const e = expand(p, home);
  return hasUnresolvedVar(e) ? null : resolve(cwd, e);
}

/** The live PAI home dirs: the default ~/.pai and the pre-migration ~/.claude/pai (see config/pai-home.ts). */
const LIVE_PAI_DIRS = livePaiHomeDirs;

/** Live PAI/Claude config that tests and workers must not write. */
export function isLiveConfig(p: string, home: string): boolean {
  if (p === `${home}/.claude.json` || p === `${home}/.claude/settings.json`) return true;
  return LIVE_PAI_DIRS(home).includes(dirname(p)) && /\.(ya?ml|json)$/.test(p);
}

const LIVE_CONFIG_REASON = "workers never write live PAI config; set HOME=$(mktemp -d) or PAI_WORKERS_YAML=<copy> for state-changing checks (tests use temp-dir copies)";

const CONFIG_VERBS = "inline-keys|add|update|remove|enable|disable|use|set";

/** True when a path value (env assignment or inherited) points outside the live PAI home (~/.pai, or legacy ~/.claude/pai). */
function outsideLivePai(v: string | undefined, home: string): boolean {
  if (!v) return false;
  const p = v.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?/, home);
  if (!p.startsWith("/")) return false;
  return !LIVE_PAI_DIRS(home).some((d) => p === d || p.startsWith(`${d}/`));
}

/**
 * A segment running a state-changing `pai worker config|providers|classes|setup` verb
 * (any entry point, e.g. `node <x>/dist/cli/index.mjs worker config inline-keys`) against the live
 * config. Safe when PAI_WORKERS_YAML (inherited or assigned in the segment) is outside ~/.claude/pai,
 * or HOME is reassigned in the segment; `--dry-run` writes nothing.
 */
function configMutationReason(words: string[], env: Record<string, string | undefined>, home: string): string | null {
  const i = words.findIndex((w, k) => w === "worker" && k + 1 < words.length);
  if (i < 0) return null;
  const [area, verb] = [words[i + 1], words[i + 2]];
  const mutating =
    (area === "setup") ||
    ((area === "config" || area === "providers" || area === "classes") && !!verb && new RegExp(`^(${CONFIG_VERBS})$`).test(verb));
  if (!mutating || words.includes("--dry-run")) return null;
  const assigned = (name: string): string | undefined => {
    for (const w of words.slice(0, i)) if (w.startsWith(`${name}=`)) return w.slice(name.length + 1);
    return undefined;
  };
  if (outsideLivePai(assigned("PAI_WORKERS_YAML") ?? env.PAI_WORKERS_YAML, home)) return null;
  const h = assigned("HOME");
  if (h && h !== "$HOME" && h !== home) return null;
  return LIVE_CONFIG_REASON;
}

/** realpath of `p`, or of its deepest existing ancestor plus the missing rest (a new file's path resolves through its parent). */
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

/** A worker's scratch roots: TMPDIR and the pai-scratch convention (same shapes as isScratchPath in worker-bash-rules.ts). */
function defaultScratchDirs(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const tmp = env.TMPDIR?.replace(/\/+$/, "");
  if (tmp) out.push(tmp);
  out.push("/tmp/pai-scratch");
  if (tmp) out.push(`${tmp.replace(/^\/private/, "")}/pai-scratch`);
  // scratch dirs of the run(s) a resume continues (PAI_SCRATCH_ALSO, ":"-separated)
  for (const d of (env.PAI_SCRATCH_ALSO ?? "").split(":")) if (d) out.push(d.replace(/\/+$/, ""));
  return out;
}

/** realpath of every allowed write root: the worktree plus each scratch dir, missing ones resolved through their parent. */
function allowedWriteRoots(c: WorkerGuardContext, env: Record<string, string | undefined>): string[] {
  const roots = [c.worktreeRoot, ...(c.scratchDirs ?? defaultScratchDirs(env))].filter((r): r is string => !!r);
  return [...new Set(roots.map((r) => realish(r)))];
}

/** True when a resolved path lies inside one of the allowed roots. */
const isInsideAny = (p: string, roots: string[]): boolean =>
  roots.some((root) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`));

/** Deny message when an Edit/Write/MultiEdit/NotebookEdit target resolves outside the worker's worktree and scratch dirs. */
function outsideWorktreeReason(p: string, c: WorkerGuardContext, env: Record<string, string | undefined>): string | null {
  if (!c.worktreeRoot) return null; // no git tree: nothing to fence against
  const real = realish(p);
  if (isInsideAny(real, allowedWriteRoots(c, env))) return null;
  return `worker: file writes outside your worktree are blocked (${p}); work in ${c.worktreeRoot}, or report what another repo needs so L0 can hand it over`;
}

/** A Bash redirect target every command legitimately writes to regardless of the fence: /dev/null (and its symlink), /dev/stdout, /dev/fd/N. */
const DEV_WRITE = /^\/dev\/(null|zero|stdout|stderr|fd\/\d+)$/;

const isTodo = (p: string): boolean => p === "Notes/TODO.md" || p.endsWith("/Notes/TODO.md");

function protectedPathReason(p: string, home: string): string | null {
  if (isTodo(p)) return "Notes/TODO.md is the orchestrator's: report what should change in your result instead";
  if (isLiveConfig(p, home)) return LIVE_CONFIG_REASON;
  return null;
}

/** True when `a` is a sed in-place flag: bare `-i`/`--in-place`, an attached suffix (`-i.bak`), or a combined short flag carrying `i` (`-ni`, `-iE`). */
const isSedInplaceFlag = (a: string): boolean => /^-[a-zA-Z]*i[a-zA-Z]*$/.test(a) || /^--in-place(=.*)?$/.test(a);

/**
 * The sed operands that are write targets (files sed edits), not scripts: the words after the
 * program options that take a separate value (`-e <script>`, `-f <scriptfile>`), minus the in-place
 * suffix BSD sed consumes when `-i`/`--in-place` is given bare (`sed -i '' 's/a/b/' f` writes f,
 * `''` is the suffix). A script is read, never written: `sed -i '' -e '/let h = dlopen/d' -e … f`
 * was denied 2026-11-24 as a write to `/let h = dlopen/d` because the script after `-e` was taken
 * as a target. GNU sed (`sed -i.bak …`) has no separate suffix word, so nothing is dropped there.
 * The dropped word is a suffix only when it is not a script: BSD sed reads the word after a bare
 * `-i` as the backup suffix whatever it is (`sed -i '~' 's/a/b/' f` backs up to `f~`), so a word
 * that looks like a script or option is kept as a target — the ambiguous deny below still catches
 * the real mistakes (`sed -i 's/a/b/' f` never reaches here: the rewrite inserts `''` first).
 */
function sedWriteTargets(args: string[]): string[] {
  const operands = sedOperands(args).filter((a) => !isFlag(a));
  const bare = args.some((a) => a === "-i" || a === "--in-place");
  if (!bare) return operands;
  const first = operands[0];
  return first !== undefined && CLEAR_SED_SCRIPT.test(first) ? operands : operands.slice(1);
}

/** Paths a segment writes to (redirects plus the write-side of common tools). */
function writeTargets(words: string[], redirects: string[]): string[] {
  const [cmd, ...args] = words;
  const pos = args.filter((a) => !isFlag(a));
  const out = [...redirects];
  if (cmd === "tee" || cmd === "mv") out.push(...pos);
  else if (cmd === "cp" && pos.length) out.push(pos[pos.length - 1]);
  else if (cmd === "sed" && args.some(isSedInplaceFlag)) out.push(...sedWriteTargets(args));
  return out;
}

const RECURSIVE_CP = /^-[a-zA-Z]*[rRa]|^--recursive$|^--archive$/;
const RECURSIVE_RSYNC = /^-[a-zA-Z]*[ra]|^--recursive$|^--archive$/;

const AI_ATTRIBUTION = /Co-Authored-By:[^\n]*(claude|anthropic)|Generated with[^\n]*Claude Code/i;

/** Message text a `git commit` carries: the raw command (-m, heredoc) plus any -F/--file body. */
function commitMessageText(rest: string[], cwd: string, raw: string, home: string): string {
  let text = raw;
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i] === "-F" || rest[i] === "--file" ? rest[i + 1] : rest[i].startsWith("--file=") ? rest[i].slice(7) : undefined;
    const p = f ? abs(f, cwd, home) : null;
    if (!p) continue;
    try {
      text += "\n" + readFileSync(p, "utf8");
    } catch {
      // missing file: nothing to check
    }
  }
  return text;
}

const GIT_TREE_CMDS = new Set(["reset", "clean", "restore", "switch", "rebase", "merge", "checkout", "stash"]);

function gitSub(args: string[]): { sub: string; rest: string[] } | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree") i++;
    else if (!isFlag(a)) return { sub: a, rest: args.slice(i + 1) };
  }
  return null;
}

const PATTERN_KILL = new Set(["pkill", "killall"]);
const PATTERN_KILL_PREFIX = "pattern-based process kill blocked";
const PATTERN_KILL_REASON =
  PATTERN_KILL_PREFIX + ": kill only what you started, by PID (`cmd & echo $! > /tmp/x.pid`, then " +
  "`kill $(cat /tmp/x.pid)`), never by name or pattern; other workers' command lines contain your spec text";

const SED_INPLACE_REASON =
  "`sed -i` without an explicit suffix argument is blocked on macOS: BSD sed takes the next word as the backup suffix and leaves a stray copy (e.g. file.ts-e); use `sed -i '' -e …` or the Edit tool";

const SED_INPLACE_NOTE = "rewrote sed -i to sed -i '' for BSD sed";

/** The word after a bare `-i` that is unmistakably a sed script or option: `-e`, `-E`, `-n`, `s/a/b/`, `y/a/b/`, `5d`, `1,3p`, `$d`. */
const CLEAR_SED_SCRIPT = /^-[a-zA-Z]+$|^[sy]([/|#,]).+\1.*\1|^(\d+|\$)(,(\d+|\$))?[a-zA-Z]/;

/** True when `-i` is its own word (not `-i.bak`, not combined) and the next word exists. */
const sedHasBareI = (args: string[]): boolean => args.includes("-i");

const GNU_SED_RANGE_REASON =
  "BSD sed has no GNU `,+N` range: use the Read tool with offset/limit, `sed -n 'X,Yp'` with an absolute end line, or `grep -n -A N pattern file`.";

const GIT_GREP_ORDER_REASON =
  "git grep reads words after the pattern as revisions: put options before the pattern, e.g. `git grep -n -A 20 \"pattern\" -- path`.";

/** Options that end at their own word (a value follows separately); everything else before the first non-option word is a leading option. */
const GIT_GREP_VALUE_OPTS = new Set(["-e", "--and", "--or", "--not", "--max-depth"]);

/**
 * True when `git grep` carries an option after its bare pattern and before `--`:
 * git reads it as a revision (`git grep -n "pat" -A 20 -- src` → `fatal: unable to resolve revision: -A`).
 * A pattern given with `-e` has no bare pattern, so options may follow it; a quoted word starting
 * with `-` is the pattern itself, not an option (parseCommand strips the quotes).
 */
export function gitGrepOptionsAfterPattern(args: string[]): boolean {
  let i = 0;
  while (i < args.length && isFlag(args[i])) {
    if (GIT_GREP_VALUE_OPTS.has(args[i])) i++; // -e <pattern>, --and <expr>: skip the value word
    i++;
  }
  if (i >= args.length || args[i] === "--") return false; // no bare pattern: nothing to be after
  for (i++; i < args.length && args[i] !== "--"; i++) if (isFlag(args[i])) return true;
  return false;
}

/** The sed address grammar: a line number, `/re/`, `\|re\|`, `%`, `$` — optionally followed by an offset (`+N` / `-N`). */
const SED_ADDR = String.raw`(?:\d+|/[^\n]*?/\\?|\|[^|\n]+\|\\?|%|\$)(?:[+-]\d+)?`;
/** A `$(…)`/backtick substitution standing in for a line number, e.g. `"$(grep -n x f | cut -d: -f1),+8p"`. */
const SED_ADDR_SUBST = String.raw`(?:\$\([^)]*\)|` + "`[^`]*`" + `)`;
/** `<addr>,+N<p>`: the GNU-only relative end line, with or without spaces (`, +8p`). */
const GNU_SED_RANGE = new RegExp(String.raw`^(?:${SED_ADDR}|${SED_ADDR_SUBST}),\s*\+\d+\s*[pned]`);
/** The same range where BOTH addresses are plain line numbers (`120,+40p`, `5, +3 p`): the form a rewrite can make BSD-valid. */
const GNU_SED_RANGE_NUMERIC = /^(\d+),\s*\+(\d+)\s*([pn])/;
/** The same range whose START is a computed substitution (`$(grep …),+20p`, `` `grep …`,+8p ``) and whose command prints: rewritten to `X,$p` + `| head -n N+1`. */
const GNU_SED_RANGE_SUBST = /^(?:(?:\$\([^)]*\)|`[^`]*`)),\s*\+(\d+)\s*(p)$/;

/**
 * True when a sed script starts with a GNU `,+N` address range (`18,+8p`, `$(…),+8p`).
 * A `,+<digits>` at the head of the script can only be an address: in a substitution or
 * address-less command it sits inside the s/// body, which never begins with a bare `,`.
 * The `$(…)` part of a quoted script survives parseCommand as text, so `$(grep …),+8p` matches too.
 */
export function hasGnuSedRange(script: string): boolean {
  return GNU_SED_RANGE.test(script);
}

/**
 * The rewrite for one sed script carrying a numeric GNU `,+N` range: `120,+40p` → `120,160p`.
 * Null when the script carries no such range, or its start address is not a plain line number
 * (`$`, `/re/`, `$(…)`): those stay denied. Only the head of the script is rewritten — that is
 * where GNU_SED_RANGE matches — which keeps an s/// body containing `,N` out of reach.
 */
export function rewriteGnuSedRange(script: string): string | null {
  const m = GNU_SED_RANGE_NUMERIC.exec(script);
  if (!m) return null;
  const [x, n] = [Number(m[1]), Number(m[2])];
  // m[3] is the command letter (`p`): only the `,+N` part becomes the absolute end line
  return script.replace(GNU_SED_RANGE_NUMERIC, (_m, start: string, _n: string, cmd: string) => `${start},${x + n}${cmd}`);
}

/** One sed script word as the shell sees it: a quoted word (single or double), else an unquoted run without spaces. */
// a quoted word ends at its LAST run of the quote char (`"$(grep 'x' f | cut -d: -f1),+8p"`): a lazy closer would
// stop at the nested `'` and split the word mid-substitution. The alternation runs left to right, so this branch
// claims quoted words before \S+ can; an unterminated quote falls through to \S+ (stays denied).
const SED_SCRIPT_WORD = /(["'])((?:(?!\1)[^]|(?<=\\)\1)*)\1(?!\1)|\S+/g;

/** The same word split, restricted to a segment's own text: words outside it must not be rewritten. */
function sedScriptWordsIn(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (!/\s/.test(text[i])) {
      const m = /^(?:(["'])((?:(?!\1)[^]|(?<=\\)\1)*)\1(?!\1)|\S+)/.exec(text.slice(i));
      if (m) out.push(m[1] ? m[2] : m[0]);
      i += m ? m[0].length : 1;
    } else i++;
  }
  return out;
}

/** The result of a sed rewrite: the new command text plus, for the computed-start form, the line cap the caller appends as `| head -n N+1`. */
export interface SedRewrite {
  text: string;
  /** Set only by the computed-start (`$(…),+Np`) rewrite: keep the first N+1 printed lines. */
  headN?: number;
}

/** The BSD form of a computed-start range: `$(…),+20p` → `$(…),$p` (the caller appends `| head -n N+1`). Null when the start is not a substitution or the command is not `p`. */
function rewriteGnuSedRangeHeadScript(script: string): { r: string; n: number } | null {
  const m = GNU_SED_RANGE_SUBST.exec(script);
  if (!m) return null;
  return { r: `${script.slice(0, script.lastIndexOf(","))},$p`, n: Number(m[1]) };
}

/**
 * A command's GNU sed ranges rewritten to BSD form, at the positions parseCommand read as this
 * sed call's script words (`sedOperands(args)`): each such word that is a `,+N` print range becomes
 * its rewrite, re-quoted as it was (parseCommand strips quotes, so the check runs on parsed words
 * but the rewrite must edit the raw text). Two forms: a numeric start `X,+Np` → `X,X+Np`; a computed
 * start `$(…),+Np` → `$(…),$p` with `headN` set — the caller appends
 * `| head -n N+1`, which prints the same lines as GNU sed would. Null when no script word carries a
 * rewritable range — including a command whose GNU-only ranges are not numeric or mutate (`d`),
 * which keeps the deny.
 */
export function gnuSedRewrite(command: string, scripts: string[]): SedRewrite | null {
  const want = new Set<string>();
  const headWant = new Map<string, number>(); // original script word -> N of its `,+N`
  for (const s of scripts) {
    if (!hasGnuSedRange(s)) continue;
    const w = rewriteGnuSedRange(s);
    if (w !== null) want.add(w);
    else {
      const h = rewriteGnuSedRangeHeadScript(s);
      if (h !== null) headWant.set(s, h.n);
    }
  }
  if (!want.size && !headWant.size) return null;
  let changed = false;
  let headN = -1;
  const out = command.replace(SED_SCRIPT_WORD, (whole, q: string | undefined, inner?: string) => {
    // unquoted scripts stay denied; a double-quoted script must survive re-quoting unchanged (no backtick or `"`).
    // whole.slice(1,-1) is the word's own text: /"/ on the quoted form always matches its own delimiters.
    if (!q || (q === '"' && /[`"]/.test(whole.slice(1, -1)))) return whole;
    const r = rewriteGnuSedRange(inner as string);
    if (r !== null && want.has(r)) {
      changed = true;
      return q === "'" ? `'${r.replace(/'/g, `'\\''`)}'` : `"${r.replace(/[$\\]/g, "\\$&")}"`;
    }
    // the head form matches the ORIGINAL script word (the rewrite changes it)
    const n = headWant.get(inner as string);
    if (n !== undefined) {
      changed = true;
      headN = Math.max(headN, n);
      // the same lines: `X,$p` prints from X to the end and the appended `| head -n N+1` caps it at N+1.
      // `$` is escaped in a double-quoted script so the shell does not expand it.
      const h = rewriteGnuSedRangeHeadScript(inner as string)!.r;
      return q === "'" ? `'${h.replace(/'/g, `'\\''`)}'` : `"${h.replace(/\$p$/, "\\$p")}"`;
    }
    return whole;
  });
  if (!changed) return null;
  return headN >= 0 ? { text: out, headN } : { text: out };
}

/** The sed args after the program options that take a separate value (`-e 'script'`, `-f file`). */
function sedOperands(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue;
    if (a === "-e" || a === "--expression" || a === "-f" || a === "--file") { i++; continue; }
    if (/^-[ef]$/.test(a)) continue; // `-en`, `-fp`: no separate value in BSD sed
    out.push(a);
  }
  return out;
}

const SEARCH_ROOT_REASON = "recursive search over the home directory or / is blocked; search a named project or cache directory, e.g. rg -n PATTERN ~/strata-020 (mdfind uses the index and is fine)";

/** find/fd/rg/ag/grep -r whose search root (explicit, or the cwd when no path is given) is the home directory or /. */
function rootWalkReason(cmd: string, args: string[], cwd: string, home: string): string | null {
  let c = cmd;
  let a = args;
  if (c === "timeout") {
    a = a.slice();
    while (a.length && isFlag(a[0])) a.shift();
    a.shift(); // the duration
    c = a.shift() ?? "";
  }
  const isRoot = (p: string): boolean => {
    const r = abs(p, cwd, home);
    return r === "/" || r === resolve(home);
  };
  let paths: string[];
  if (c === "find") {
    const i = a.findIndex((w) => /^(-|!$|\(|\)$)/.test(w));
    paths = a.slice(0, i < 0 ? a.length : i);
  } else if (c === "grep") {
    if (!a.some((w) => w === "--recursive" || /^-[A-Za-z]*[rR]/.test(w))) return null;
    paths = a.filter((w) => !isFlag(w)).slice(1);
  } else if (c === "fd" || c === "fdfind" || c === "rg" || c === "ag") {
    paths = a.filter((w) => !isFlag(w)).slice(1);
  } else return null;
  if (paths.length === 0) paths = ["."];
  return paths.some(isRoot) ? SEARCH_ROOT_REASON : null;
}

/** The env for the Bash write fence (scratch roots from TMPDIR); set by decideWorkerGuard before command decisions. */
let FENCE_ENV: Record<string, string | undefined> = {};

/** Decide one segment; `st.cwd` is the tracked working directory. The segments come from parseCommand (heredoc bodies blanked), and `st.raw` — what a git commit message check reads — has them blanked too: heredoc text is data, not commands. */
function decideSegment(seg: Segment, st: { cwd: string; raw: string; rewrite?: string; note?: string }, ctx: WorkerGuardContext, detached = false): GateDecision {
  const words = stripPrefix(seg.words);
  const [cmd, ...args] = words;
  const boundary = ctx.worktreeRoot ?? ctx.cwd;

  for (const t of writeTargets(words.length ? words : [""], seg.redirects)) {
    const p = abs(t, st.cwd, ctx.home);
    const why = p && protectedPathReason(p, ctx.home);
    if (why) return deny(`write to ${t} blocked: ${why}`);
    // the same worktree fence as Edit/Write: a redirect or tee/mv/cp/sed -i target outside the worktree and scratch dirs.
    // /dev writes are exempt, and `sed -i <suffix>`'s suffix word (a backup suffix, not a path) is skipped by writeTargets' caller below.
    const out = p && !DEV_WRITE.test(p) && outsideWorktreeReason(p, ctx, FENCE_ENV);
    if (out) return deny(out);
  }
  if (!cmd) return ALLOW;

  if ((cmd === "bash" || cmd === "sh" || cmd === "zsh") && /^-\w*c$/.test(args[0] ?? "") && args[1]) {
    return decideCommand(args[1], { ...ctx, cwd: st.cwd }, detached);
  }

  if (cmd === "eval" && args.length) return decideCommand(args.join(" "), { ...ctx, cwd: st.cwd }, detached);

  const pos = args.filter((a) => !isFlag(a));

  if (PATTERN_KILL.has(cmd) || (seg.words.includes("xargs") && cmd === "kill") || (cmd === "kill" && /pgrep|pidof/.test(args.join(" ")))) {
    return deny(PATTERN_KILL_REASON);
  }

  if (cmd === "sed" && process.platform === "darwin") {
    const i = args.indexOf("-i");
    const next = i >= 0 ? args[i + 1] : undefined;
    // BSD sed rejects every GNU `,+N` range (`sed -n "18,+8p" f`): it fails with `invalid command code ,`, every time.
    // A numeric print range is translated instead of denied (the intent is unambiguous, and denials burned workers turns):
    // the command goes on with `X,+N` rewritten to `X,<X+N>`; anything else GNU-only (non-numeric start, `$(…)`, a mutating
    // command like `d`, or `-i`) stays denied.
    if (sedOperands(args).some(hasGnuSedRange)) {
      const rawSeg = st.raw.slice(seg.start, seg.end);
      const rewritten = args.length ? gnuSedRewrite(rawSeg, sedOperands(args)) : null;
      if (!rewritten || next !== undefined) return deny(GNU_SED_RANGE_REASON);
      // a computed start `$(…),+Np` becomes the BSD `X,$p` (same lines to the end of the file): the cap goes on as
      // `| head -n N+1`, appended right after this segment so a following pipeline (`… | grep x`) or command (`; next`) stays intact.
      const ws = /\s*$/.exec(rewritten.text)![0]; // the segment's trailing blanks move after the cap
      const tailCmd = rewritten.headN !== undefined ? ` | head -n ${rewritten.headN + 1}${ws}` : "";
      if (rewritten.headN !== undefined) rewritten.text = rewritten.text.slice(0, rewritten.text.length - ws.length);
      // splice the rewritten segment (plus the cap for a computed start) back into the heredoc-blanked text
      // (blanking preserves offsets, so these slice the original command too)
      const spliced = st.raw.slice(0, seg.start) + rewritten.text + tailCmd + st.raw.slice(seg.end);
      // nothing else in the command may carry a GNU range the splice left untouched
      if (parseCommand(spliced).some((s) => { const w = stripPrefix(s.words); return w[0] === "sed" && process.platform === "darwin" && sedOperands(w.slice(1)).some(hasGnuSedRange); })) return deny(GNU_SED_RANGE_REASON);
      st.rewrite = spliced;
      return { decision: "allow", context: `rewrote sed X,+N to BSD form: ${spliced}` };
    }
    // GNU-style `sed -i <script>` / `sed -i -e …` (no suffix word): when the word after -i is clearly a script or an option,
    // insert the empty suffix BSD sed wants instead of denying. Anything less clear keeps the deny below.
    if (next !== undefined && next !== "--" && CLEAR_SED_SCRIPT.test(next) && sedHasBareI(args)) {
      const rawSeg = st.raw.slice(seg.start, seg.end);
      const m = /(^|\s)-i(?=\s)/.exec(rawSeg);
      if (m) {
        const at = m.index + m[0].length;
        const spliced = st.raw.slice(0, seg.start) + rawSeg.slice(0, at) + " ''" + rawSeg.slice(at) + st.raw.slice(seg.end);
        // the splice must read back as `-i ''` on this sed call, else keep the deny (and never loop on a bad splice)
        const back = parseCommand(spliced).find((x) => x.start === seg.start);
        const bw = back ? stripPrefix(back.words) : [];
        if (bw[0] === "sed" && bw[bw.indexOf("-i") + 1] === "") {
          st.rewrite = spliced;
          st.note = SED_INPLACE_NOTE;
          return ALLOW;
        }
      }
    }
    if (next !== undefined && next !== "" && next !== "--" && (isFlag(next) || /^[sy]$/.test(next) || /^[a-zA-Z][/|#,]/.test(next) || /^[\d$/\\]/.test(next) || /[;\s/{]/.test(next))) return deny(SED_INPLACE_REASON);
  }

  const chrome = chromeStartReason(cmd, args);
  if (chrome) return deny(chrome);

  const walk = rootWalkReason(cmd, args, st.cwd, ctx.home);
  if (walk) return deny(walk);

  const bench = ctx.benchGo ? null : benchStartReason(cmd, args, st.cwd, st.raw);
  if (bench) return deny(bench);

  if (cmd === "cd") {
    const p = pos[0] ? abs(pos[0], st.cwd, ctx.home) : null;
    if (!p) return ALLOW;
    if (ctx.mainCheckout && ctx.worktreeRoot && isInside(p, ctx.mainCheckout) && !isInside(p, ctx.worktreeRoot)) {
      return deny(`cd ${pos[0]} blocked: it leaves your worktree for the main checkout; use paths relative to your worktree`);
    }
    st.cwd = p;
    return ALLOW;
  }

  if (cmd === "ln" && args.some((a) => /^-[a-zA-Z]*s|^--symbolic$/.test(a)) && pos.length) {
    const link = pos[1] ? abs(pos[1], st.cwd, ctx.home) : null;
    const from = link ? dirname(link) : st.cwd;
    const target = abs(pos[0], from, ctx.home);
    if (target && !isInside(target, boundary)) {
      return deny("ln -s to a target outside your worktree blocked: the runner provisions node_modules in your worktree");
    }
    return ALLOW;
  }

  if ((cmd === "cp" && args.some((a) => RECURSIVE_CP.test(a))) || (cmd === "rsync" && args.some((a) => RECURSIVE_RSYNC.test(a)))) {
    if (pos.length >= 2) {
      const dest = abs(pos[pos.length - 1], st.cwd, ctx.home);
      const roots = [boundary, ctx.mainCheckout].filter((r): r is string => !!r);
      const copiesRoot = pos.slice(0, -1).some((s) => {
        const p = abs(s, st.cwd, ctx.home);
        return !!p && roots.includes(p);
      });
      if (copiesRoot && dest && !isInside(dest, boundary)) {
        return deny(`${cmd} of the repo tree out of your worktree blocked: build and test inside your worktree, never from a copy`);
      }
    }
    return ALLOW;
  }

  if ((cmd === "npm" || cmd === "bun" || cmd === "pnpm" || cmd === "yarn") && pos[0] === "publish") {
    return deny(`${cmd} publish blocked: releases are the orchestrator's`);
  }
  if (cmd === "npm" && pos[0] === "version" && pos.length > 1) {
    return deny("npm version blocked: version bumps are the orchestrator's");
  }

  if (cmd === "bun" && pos[0] === "test" && /vitest/.test(ctx.testScript() ?? "")) {
    return deny("bun test blocked: this repo's tests are vitest; run `npx vitest run <files>`");
  }

  if (cmd === "git") {
    const g = gitSub(args);
    if (!g) return ALLOW;
    if (g.sub === "push") return deny("git push blocked: pushing is the orchestrator's; commit on your branch and stop");
    // `git grep -n "pat" -A 20 -- src` fails with `fatal: unable to resolve revision: -A`: options go before the pattern
    if (g.sub === "grep" && gitGrepOptionsAfterPattern(g.rest)) return deny(GIT_GREP_ORDER_REASON);
    if (g.sub === "commit" && AI_ATTRIBUTION.test(commitMessageText(g.rest, st.cwd, st.raw, ctx.home))) {
      return deny("no AI attribution in commits (operator rule): drop the Co-Authored-By / Generated-with line and commit again");
    }
    if (g.sub === "tag") {
      const listing = !g.rest.some((a) => !isFlag(a)) || g.rest.some((a) => /^(-l|--list|-n\d*|--contains|--points-at)$/.test(a));
      if (!listing) return deny("git tag blocked: releases are the orchestrator's");
    }
    if (ctx.inWorktree && detachesHead(g)) {
      return deny("detaching HEAD in your worktree blocked: commits made there land off your branch; commit on your branch");
    }
    if (!ctx.inWorktree && (ctx.sharedCheckout?.() ?? true) && !isPrivateClone(ctx.cwd)) {
      if (GIT_TREE_CMDS.has(g.sub)) {
        const r = decideWorkerGitGuard(words.join(" "), true, st.cwd, null);
        if (r.blocked) return deny(`${r.cmd} blocked: you run in a shared checkout, not a worktree; it can destroy other workers' edits, use --worktree`);
      }
      if (g.sub === "checkout" && g.rest.some((a) => !isFlag(a))) {
        return deny("git checkout <branch> blocked: you run in a shared checkout, not a worktree; use --worktree");
      }
    }
  }
  return ALLOW;
}

/**
 * The unbounded busy loop: `while :; do :; done`, `until true; do :; done`, `for ((;;))` — a shell spin that
 * burns a whole core and, backgrounded, outlives the worker that started it (2026-11-17/18 overnight: a
 * scratch load-probe's `while :; do :; done &` loops were reparented to launchd and held load 160 for
 * 10 h, starving every session on the machine). A loop is only a busy loop when its body runs no real
 * command: `:`/`true`/`false`, sleep, nested loops and control words are not work. `yes > /dev/null &`
 * spins just the same without any loop syntax.
 */
const BUSY_LOOP_RE = /\b(while|until)\b[^;\n]*[;\n]\s*do\b([\s\S]*?)\bdone\b\s*(?:[)]\s*)?&|\bfor\s*\(\(\s*;\s*;\s*\)\)\s*(?:do\b([\s\S]*?)\bdone)?\s*[;&]/g;
const BUSY_BODY_WORD = new Set(["", ":", "true", "false", "sleep", "while", "until", "for", "if", "then", "else", "elif", "do", "done", "{", "}", "(", ")", "!", "wait"]);
/** The same loop grammar without the paired-background requirement: a busy loop anywhere in text that holds a background. */
const BUSY_LOOP_ANY_RE = /\b(while|until)\b[^;\n]*[;\n]\s*do\b([\s\S]*?)\bdone\b|\bfor\s*\(\(\s*;\s*;\s*\)\)\s*(?:do\b([\s\S]*?)\bdone)?/g;
/** A backgrounded `yes` (or a yes/gnu-yes in a pipeline) with no duration cap: an infinite byte spinner. */
const YES_BG_RE = /(?:^|[\s;&|(])((?:g)?nu?-?yes|(?:\/\S+\/)?y(?:es|ss))\b[^;&|\n]*&/;

/** True when a loop body holds no real command (only `:`/true/false/sleep/nested loops/control words). */
function busyLoopBody(body: string): boolean {
  const inner = parseCommand(body);
  if (!inner.length) return true;
  for (const seg of inner) {
    const w = stripPrefix(seg.words)[0];
    if (w === undefined) continue;
    if (BUSY_BODY_WORD.has(w)) continue;
    if (/^\d+$/.test(w)) continue; // `2>/dev/null` left as its own token by the splitter
    return false;
  }
  return true;
}

/** Deny a backgrounded unbounded busy loop: a spin that survives the worker and starves the machine. */
export function busyLoopReason(command: string): string | null {
  let text = blankHeredocBodies(command);
  // `timeout N …` caps the spin by definition: what it wraps is bounded, not an unbounded loop.
  // The duration may sit behind flag values (`timeout -k 5 20`, `perl -e 'alarm 20; exec @ARGV'`).
  text = text.replace(/\b(?:g?timeout|perl)\b([^;&|\n]*)/g, (whole, head) => {
    const m = /(?:^|\s)((?:-\S+\s+)*)(\d+(?:\.\d+)?[smhd]?)(?=\s)/.exec(head);
    return m ? whole.slice(0, m.index) + m[1] + " ".repeat(m[2].length) : whole;
  });
  for (const m of text.matchAll(BUSY_LOOP_RE)) {
    if (busyLoopBody(m[2] ?? m[3] ?? "")) return BUSY_LOOP_REASON;
  }
  // `while :; do :; done` anywhere a background follows it: `sh -c '…' &`, `setsid sh -c '…' &` and the
  // function-body form all hide the loop behind quotes or a `&` that closes an OUTER command, where the
  // text regex above cannot pair loop with background. A quoted payload is a spinner only when every
  // `… &` inside it ends in a busy loop (the documented nohup job recipe stays allowed).
  if (/\S\s*&/.test(text)) {
    for (const m of text.matchAll(BUSY_LOOP_ANY_RE)) {
      if (busyLoopBody(m[2] ?? m[3] ?? "")) return BUSY_LOOP_REASON;
    }
    for (const q of text.matchAll(/'([^']*)'|"([^"]*)"/g)) {
      const inner = q[1] ?? q[2];
      if (!/&/.test(inner)) continue;
      const loops = [...inner.matchAll(BUSY_LOOP_RE)];
      if (loops.length && loops.every((m) => busyLoopBody(m[2] ?? m[3] ?? ""))) return BUSY_LOOP_REASON;
    }
  }
  if (YES_BG_RE.test(text)) return BUSY_LOOP_REASON;
  return null;
}

const BUSY_LOOP_REASON =
  "unbounded busy loop blocked: `while :; do :; done &` / `yes > /dev/null &` burns a core and outlives your run when backgrounded (an overnight load-probe held load 160 for 10 h and starved the machine). " +
  "Cap it with a duration — `timeout 20 <command>` — or use `pai worker wait-on` for a detached job.";

const MAX_FOREGROUND_SECS = 120;
const WAIT_REASON_TAIL =
  "calls longer than 2 min block operator messages and supervision; long jobs run fine detached: " + WAIT_RECIPE + ".";

const CLAMP_NOTE = "timeout clamped to 120 s; `--wait` commands return by themselves, rc=3 = run again";

const unitSecs = (u: string): number => (u === "m" ? 60 : u === "h" ? 3600 : u === "d" ? 86_400 : 1);

/** Longest `timeout N` (timeout/gtimeout, any flags) among the segments, in seconds. */
function longestTimeoutSecs(segs: Segment[]): number {
  let longest = 0;
  for (const seg of segs) {
    const [cmd, ...args] = stripPrefix(seg.words);
    if (cmd !== "timeout" && cmd !== "gtimeout") continue;
    for (let i = 0; i < args.length; i++) {
      if (/^-[sk]$/.test(args[i])) i++;
      else if (!isFlag(args[i])) {
        const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(args[i]);
        if (m) longest = Math.max(longest, Number(m[1]) * unitSecs(m[2]));
        break;
      }
    }
  }
  return longest;
}

/** Deny a foreground command that would block longer than 2 min; `nohup …` segments are the detached launch and exempt. Heredoc bodies never count: their text is data, not commands. */
function longWaitReason(command: string, segs: Segment[]): string | null {
  const fg = segs.filter((s) => s.words[0] !== "nohup");
  const t = longestTimeoutSecs(fg);
  if (t > MAX_FOREGROUND_SECS) return `timeout ${t}s blocked: ${WAIT_REASON_TAIL}`;
  // Quoted text and nohup launches are not foreground sleeps; loops count at least one sleep floor (one parser: totalSleepSecs).
  const bare = blankHeredocBodies(command).replace(/'[^']*'|"[^"]*"/g, "''").replace(/\bnohup\b[^;&|\n]*/g, "");
  const s = totalSleepSecs(bare);
  if (s > MAX_FOREGROUND_SECS) return `sleep ${s}s blocked: ${WAIT_REASON_TAIL}`;
  return null;
}

function decideCommand(command: string, ctx: WorkerGuardContext, detached = false): GateDecision {
  // one pass over the text: heredoc bodies blanked for every rule below (parseCommand segments, the sleep scan, the commit message)
  const st: { cwd: string; raw: string; rewrite?: string; note?: string } = { cwd: ctx.cwd, raw: blankHeredocBodies(command) };
  const segs = parseCommand(command);
  // the busy-loop check reads raw text (parseCommand's `&` splitting loses which loop was backgrounded),
  // and runs at every depth including inside `nohup … &` / `bash -c '…' &` payloads
  const spin = busyLoopReason(st.raw);
  if (spin) return deny(spin);
  const long = detached ? null : longWaitReason(command, segs);
  if (long) return deny(long);
  for (const seg of segs) {
    const d = decideSegment(seg, st, ctx, seg.words[0] === "nohup");
    if (d.decision === "deny") return d;
  }
  // a segment rule that translated the command (the GNU sed range rewrite): re-decide the rewritten text so no other rule misses it, and hand the new command up
  if (st.rewrite && st.rewrite !== command) {
    const redone = decideCommand(st.rewrite, ctx, detached);
    if (redone.decision !== "allow") return redone;
    // one note only, on the decision that carries the new command: a nested rewrite's note already names the final command
    const note = st.note ?? `rewrote sed X,+N to BSD form: ${st.rewrite}`;
    return { decision: "allow", updatedInput: { command: (redone.updatedInput?.command as string | undefined) ?? st.rewrite }, context: [note, redone.context].filter(Boolean).join("; ") };
  }
  return ALLOW;
}

/** Local-model workers only: the guards for scratch-in-root and destructive edits (measured 2026-10-15). */
function isLocalWorker(env: Record<string, string | undefined>): boolean {
  const p = env.PAI_WORKER_PROVIDER;
  return !!p && p !== "anthropic";
}

function isTracked(file: string): boolean {
  try {
    execFileSync("git", ["-C", dirname(file), "ls-files", "--error-unmatch", "--", file], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const lineCount = (s: string): number => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));

function repoExts(root: string): Set<string> {
  let files: string[];
  try {
    files = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8", timeout: 5_000 }).split("\n");
  } catch {
    files = readdirSync(root);
  }
  return new Set(files.map((f) => extname(f).toLowerCase()).filter(Boolean));
}

function localEditReason(tool: string, p: string, content: unknown, root: string | null): string | null {
  if (!existsSync(p)) {
    return root && dirname(p) === root && isScratchRootFile(basename(p), repoExts(root))
      ? `${p} would be a new scratch file in the repo root; put scratch in $TMPDIR or a per-run mktemp dir`
      : null;
  }
  if (tool !== "Write" || typeof content !== "string") return null;
  if (!isTracked(p)) return null;
  const old = lineCount(readFileSync(p, "utf8"));
  const now = lineCount(content);
  return old - now > 40 && now < old / 2 ? `rewrite would delete ${old - now} of ${old} lines; use Edit for the change` : null;
}

/** True when a tracked file is not in the commit this branch started from (the oldest HEAD reflog entry): the worker added it itself. */
function addedByBranch(file: string): boolean {
  try {
    const dir = dirname(file);
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
    const base = git("reflog", "show", "--format=%H", "HEAD").split("\n").pop();
    if (!base) return false;
    const rel = git("ls-files", "--full-name", "--", file).split("\n")[0];
    if (!rel) return false;
    try {
      git("cat-file", "-e", `${base}:${rel}`);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

/** The prune plan's file list from PAI_WORKER_PRUNE_FILES (set only by `pai tests prune --apply`): the tracked files this worker may delete. */
function pruneAllowedFiles(env: Record<string, string | undefined>): Set<string> | null {
  const raw = env.PAI_WORKER_PRUNE_FILES;
  if (!raw) return null;
  const files = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  return files.length ? new Set(files) : null;
}

function localRmReason(segs: Segment[], cwd: string, env: Record<string, string | undefined>): string | null {
  const planned = pruneAllowedFiles(env);
  for (const { words } of segs) {
    const i = words[0] === "rm" ? 1 : words[0] === "git" && words[1] === "rm" ? 2 : -1;
    if (i < 0) continue;
    for (const w of words.slice(i)) {
      if (w.startsWith("-")) continue;
      const f = resolve(cwd, w);
      if (!(existsSync(f) && isTracked(f) && !addedByBranch(f))) continue;
      // the `pai tests prune --apply` worker may delete exactly its plan's files: same repo-relative path, nothing else
      if (planned) {
        const key = planKey(f, ctxRepoRoot(cwd));
        if (key && planned.has(key)) continue;
      }
      return `${words.slice(0, i).join(" ")} of tracked ${w} blocked: Local workers do not delete tracked files${planned ? ` (only the files listed in PAI_WORKER_PRUNE_FILES may be deleted here)` : ""}. Leave ${w} as is, finish the rest, and list it in your report as \`delete: ${w} (<reason>)\`; your orchestrator deletes it.`;
    }
  }
  return null;
}

/** Repo top-level of cwd (git rev-parse --show-toplevel); falls back to cwd outside a repo. */
function ctxRepoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim() || cwd;
  } catch {
    return cwd;
  }
}

/** The file's path relative to the repo root, as a prune plan lists it (slash form); "" when outside the repo. */
function planKey(file: string, root: string): string {
  // git reports its toplevel through symlinks (/var -> /private/var), so walk from the file up to the
  // realpath-resolved root and join the names; the plan's own paths are repo-root-relative strings.
  const rroot = realpathSync(root);
  let dir = dirname(file);
  const names: string[] = [basename(file)];
  while (realpathSync(dir) !== rroot) {
    const parent = dirname(dir);
    if (parent === dir) return ""; // reached the filesystem top without finding the repo root
    names.unshift(basename(dir));
    dir = parent;
  }
  return names.join("/");
}

export function decideWorkerGuard(
  input: WorkerGuardInput,
  env: Record<string, string | undefined>,
  ctx: () => WorkerGuardContext
): GateDecision {
  if (env.PAI_WORKER !== "1") return ALLOW;
  FENCE_ENV = env; // the Bash write fence reads TMPDIR from here
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};

  // the operator paused this worker from its pane (/pause): it answers and waits for /continue, so its
  // hands stay off the task — Edit/Write/Bash are denied until the pause clears
  if (tool === "Edit" || tool === "Write" || tool === "Bash") {
    let logDir: string;
    try {
      logDir = env.PAI_WORKER_LOOP_DIR || workersLogDir(readWorkersSection().workers);
    } catch {
      logDir = ""; // unresolvable logDir: no pause to read, work goes on
    }
    const wid = logDir && currentWorkerId(env, logDir);
    if (wid) {
      // paused and its who-by from ONE file read: two reads can tear across the sweep's resume between
      // them (paused true, pausedBy gone) and deny a preemption pause with the operator's text
      const st = readPauseState(logDir, wid);
      if (st?.paused === true) {
        const by = st.pausedBy;
        // a preemption pause is not the operator's: it ends with the preemptor. Denying every tool call
        // while it lasts only burns turns (the 28-denials loop), so wait in the gate for it to clear —
        // bounded at one Bash timeout (100 s): past that deny once, and a worker that stops calling tools
        // is released by the sweep with no denials at all. The env escape hatch keeps tests (and any
        // caller that must not block) immediate.
        if (by && env.PAI_WORKER_PREEMPT_WAIT !== "0") {
          const t0 = Date.now();
          const maxMs = Number(env.PAI_WORKER_PREEMPT_WAIT_MS) > 0 ? Number(env.PAI_WORKER_PREEMPT_WAIT_MS) : 100_000;
          const waited = waitWhilePreempted(logDir, wid, maxMs);
          if (!workerPaused(logDir, wid)) return ALLOW;
          return deny(preemptDeny(by, waited ? Math.round((Date.now() - t0) / 1000) : undefined));
        }
        return deny(PAUSE_DENY);
      }
    }
  }

  if (env.PAI_WORKER_NO_BROWSER === "1" && tool?.startsWith("mcp__") && isBrowserTool(tool)) {
    return deny(`${tool} blocked: this worker runs with --no-browser`);
  }
  if (tool === "Bash") {
    const d = typeof ti.command === "string" ? decideCommand(ti.command, { ...ctx(), benchGo: env.PAI_BENCH_GO === "1" }) : ALLOW;
    if (d.decision === "allow" && typeof ti.command === "string") {
      // a translated command (the GNU sed range rewrite) is what runs: every rule below checks that text, not the original
      const cmd = (d.updatedInput?.command as string | undefined) ?? (ti.command as string);
      // tests: operator (.pai/checks.yaml) — the operator runs the tests; --allow-tests (PAI_WORKER_ALLOW_TESTS=1) allows them
      if (env.PAI_WORKER_ALLOW_TESTS !== "1") {
        const c = ctx();
        const testsByOperator = c.testCommand ? projectTestsByOperator(c.cwd) : false;
        if (testsByOperator) {
          const why = c.testCommand!(cmd);
          if (why) return deny(why);
        }
      }
      const ba = browserAutomationBashReason(cmd, ctx().cwd, env.TMPDIR);
      if (ba) return deny(ba);
      const cfg = parseCommand(cmd).map((sg) => configMutationReason(sg.words, env, ctx().home)).find((r) => r);
      if (cfg) return deny(cfg);
      // a worker starts children on the mode chain: --model/--provider only when its own brief names one
      const route = childRouteReason(cmd, ctx().taskText?.());
      if (route) return deny(route);
      // a SQL client whose SQL writes is denied unless read-only / a scratch-or-allowlisted target / --allow-db-writes (2026-11-18: a worker INSERTed into a live index through docker exec psql)
      const gw = ctx();
      const dbw = dbWriteReason(cmd, env, { cwd: gw.cwd, home: gw.home, worktreeRoot: gw.worktreeRoot, dbWriteAllow: gw.dbWriteAllow });
      if (dbw) return deny(dbw);
      const lcr = liveContainerReason(cmd, env, { cwd: gw.cwd, home: gw.home, worktreeRoot: gw.worktreeRoot, dbWriteAllow: gw.dbWriteAllow, liveContainers: gw.liveContainers });
      if (lcr) return deny(lcr);
      // the package's own test script (if it runs tsx) legitimises its node-based runner form in nodeOnTypeScriptReason
      const why = nodeOnTypeScriptReason(cmd, ctx().testScript()) ?? tscFileArgReason(cmd) ?? maskedProofReason(cmd) ?? tmpScratchReason(cmd) ?? forceAddReason(cmd, ctx().isIgnored ?? (() => false), ctx().cwd);
      if (why) return deny(why);
      if (isLocalWorker(env)) {
        const why2 = localRmReason(parseCommand(cmd), ctx().cwd, env);
        if (why2) return deny(why2);
      }
    }
    if (d.decision === "allow") {
      const eff = d.updatedInput ? { ...ti, ...d.updatedInput } : ti;
      const raised = raiseWaitTimeout(eff);
      if (raised) return { decision: "allow", updatedInput: raised, ...(d.context && { context: d.context }) };
    }
    // A too-long tool timeout alone is clamped, not refused: models re-issued the same call and burned turns on denials.
    if (d.decision === "allow" && typeof ti.timeout === "number" && ti.timeout > MAX_FOREGROUND_SECS * 1000) {
      return { decision: "allow", updatedInput: { ...ti, ...(d.updatedInput ?? {}), timeout: MAX_FOREGROUND_SECS * 1000 }, context: d.context ? `${d.context} ${CLAMP_NOTE}` : CLAMP_NOTE };
    }
    return d;
  }
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const f = ti.file_path ?? ti.path ?? ti.notebook_path;
    if (typeof f !== "string") return ALLOW;
    const c = ctx();
    const p = abs(f, c.cwd, c.home);
    // the worktree fence first: a worker may only write inside its own worktree or scratch dirs
    // (2026-11-19: a worker edited another repo's files from its PAI worktree)
    const out = p && outsideWorktreeReason(p, c, env);
    if (out) return deny(out);
    const ba = p && browserAutomationEditReason(p, addedText(ti as never));
    if (ba) return deny(ba);
    const why = p && protectedPathReason(p, c.home);
    if (why) return deny(`edit of ${f} blocked: ${why}`);
    const local = p && isLocalWorker(env) && (tool === "Write" || tool === "Edit") ? localEditReason(tool, p, ti.content, c.worktreeRoot) : null;
    return local ? deny(local) : ALLOW;
  }
  return ALLOW;
}
