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
 * across segments. Not caught (false negatives chosen over blocking real
 * work): $(...) / backtick substitutions, subshell/brace grouping, variables
 * other than ~ and $HOME in paths, scripts that do the forbidden thing
 * internally, `git -C <other>` targeting another repo's cwd, cp/rsync with
 * -t or a source that is a subdirectory of the tree.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { livePaiHomeDirs } from "../../../config/pai-home.js";
import { type GateDecision } from "./render-decision.js";
import { decideWorkerGitGuard, isPrivateClone } from "./worker-git-guard.js";
import { isBrowserTool } from "../../../workers/browser-tools.js";
import { totalSleepSecs } from "../../../workers/status.js";
import { WAIT_RECIPE } from "../../../workers/wait-on.js";
import { forceAddReason, maskedProofReason, tmpScratchReason, nodeOnTypeScriptReason, tscFileArgReason } from "./worker-bash-rules.js";
import { dropHeredocBodies } from "./heredoc.js";
import { isScratchRootFile } from "./worker-scratch-name.js";
import { chromeStartReason } from "./worker-chrome-rules.js";
import { benchStartReason } from "./worker-bench-rules.js";
import { raiseWaitTimeout } from "./wait-timeout.js";
import { PAUSE_DENY, preemptDeny, workerPaused, workerPreemptedBy } from "../../../workers/pane-bar.js";
import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import { currentWorkerId } from "../../../workers/worker-id.js";

export interface WorkerGuardInput {
  tool_name?: string;
  cwd?: string;
  tool_input?: { command?: string; file_path?: string; path?: string; content?: string; timeout?: number };
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
  /** Whether git ignores this path (git check-ignore); absent = nothing is ignored. */
  isIgnored?: (path: string) => boolean;
  /** The operator's go for benchmarks and model servers (env PAI_BENCH_GO=1). */
  benchGo?: boolean;
}

interface Segment {
  words: string[];
  /** Redirection targets (`> f`, `>> f`, `2>f`). */
  redirects: string[];
}

const deny = (reason: string): GateDecision => ({ decision: "deny", reason });
const ALLOW: GateDecision = { decision: "allow" };

/** Split into segments; quotes group words, operators outside quotes split. */
export function parseCommand(raw: string): Segment[] {
  const command = dropHeredocBodies(raw);
  const segs: Segment[] = [];
  let seg: Segment = { words: [], redirects: [] };
  let tok = "";
  let has = false; // a token is in progress (covers empty quoted "")
  let quote: string | null = null;
  let target: "redir" | "skip" | null = null;

  const flushTok = (): void => {
    if (!has) return;
    if (target === "redir") seg.redirects.push(tok);
    else if (target !== "skip") seg.words.push(tok);
    target = null;
    tok = "";
    has = false;
  };
  const endSeg = (): void => {
    flushTok();
    if (seg.words.length || seg.redirects.length) segs.push(seg);
    seg = { words: [], redirects: [] };
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
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      tok += command[++i];
      has = true;
    } else if (/\s/.test(ch) && ch !== "\n") {
      flushTok();
    } else if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      if (ch === "&" && command[i + 1] === ">") continue; // `&>` redirects
      endSeg();
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
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
      tok += ch;
      has = true;
    }
  }
  endSeg();
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

/** Drop env assignments, wrapper commands, control keywords and xargs flags from the front. */
function stripPrefix(words: string[]): string[] {
  const out = [...words];
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

const isTodo = (p: string): boolean => p === "Notes/TODO.md" || p.endsWith("/Notes/TODO.md");

function protectedPathReason(p: string, home: string): string | null {
  if (isTodo(p)) return "Notes/TODO.md is the orchestrator's: report what should change in your result instead";
  if (isLiveConfig(p, home)) return LIVE_CONFIG_REASON;
  return null;
}

/** Paths a segment writes to (redirects plus the write-side of common tools). */
function writeTargets(words: string[], redirects: string[]): string[] {
  const [cmd, ...args] = words;
  const pos = args.filter((a) => !isFlag(a));
  const out = [...redirects];
  if (cmd === "tee" || cmd === "mv") out.push(...pos);
  else if (cmd === "cp" && pos.length) out.push(pos[pos.length - 1]);
  else if (cmd === "sed" && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) out.push(...pos);
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

/** Decide one segment; `st.cwd` is the tracked working directory. */
function decideSegment(seg: Segment, st: { cwd: string; raw: string }, ctx: WorkerGuardContext, detached = false): GateDecision {
  const words = stripPrefix(seg.words);
  const [cmd, ...args] = words;
  const boundary = ctx.worktreeRoot ?? ctx.cwd;

  for (const t of writeTargets(words.length ? words : [""], seg.redirects)) {
    const p = abs(t, st.cwd, ctx.home);
    const why = p && protectedPathReason(p, ctx.home);
    if (why) return deny(`write to ${t} blocked: ${why}`);
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
    if (next !== undefined && next !== "" && (isFlag(next) || /^[sy]([/|#,]|$)/.test(next))) return deny(SED_INPLACE_REASON);
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

/** Deny a foreground command that would block longer than 2 min; `nohup …` segments are the detached launch and exempt. */
function longWaitReason(command: string, segs: Segment[]): string | null {
  const fg = segs.filter((s) => s.words[0] !== "nohup");
  const t = longestTimeoutSecs(fg);
  if (t > MAX_FOREGROUND_SECS) return `timeout ${t}s blocked: ${WAIT_REASON_TAIL}`;
  // Quoted text and nohup launches are not foreground sleeps; loops count at least one sleep floor (one parser: totalSleepSecs).
  const bare = command.replace(/'[^']*'|"[^"]*"/g, "''").replace(/\bnohup\b[^;&|\n]*/g, "");
  const s = totalSleepSecs(bare);
  if (s > MAX_FOREGROUND_SECS) return `sleep ${s}s blocked: ${WAIT_REASON_TAIL}`;
  return null;
}

function decideCommand(command: string, ctx: WorkerGuardContext, detached = false): GateDecision {
  const st = { cwd: ctx.cwd, raw: command };
  const segs = parseCommand(command);
  const long = detached ? null : longWaitReason(command, segs);
  if (long) return deny(long);
  for (const seg of segs) {
    const d = decideSegment(seg, st, ctx, seg.words[0] === "nohup");
    if (d.decision === "deny") return d;
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

function localRmReason(segs: Segment[], cwd: string): string | null {
  for (const { words } of segs) {
    const i = words[0] === "rm" ? 1 : words[0] === "git" && words[1] === "rm" ? 2 : -1;
    if (i < 0) continue;
    for (const w of words.slice(i)) {
      if (w.startsWith("-")) continue;
      const f = resolve(cwd, w);
      if (existsSync(f) && isTracked(f) && !addedByBranch(f)) return `${words.slice(0, i).join(" ")} of tracked ${w} blocked: Local workers do not delete tracked files. Leave ${w} as is, finish the rest, and list it in your report as \`delete: ${w} (<reason>)\`; your orchestrator deletes it.`;
    }
  }
  return null;
}

export function decideWorkerGuard(
  input: WorkerGuardInput,
  env: Record<string, string | undefined>,
  ctx: () => WorkerGuardContext
): GateDecision {
  if (env.PAI_WORKER !== "1") return ALLOW;
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
    if (wid && workerPaused(logDir, wid)) {
      const by = workerPreemptedBy(logDir, wid);
      return deny(by ? preemptDeny(by) : PAUSE_DENY);
    }
  }

  if (env.PAI_WORKER_NO_BROWSER === "1" && tool?.startsWith("mcp__") && isBrowserTool(tool)) {
    return deny(`${tool} blocked: this worker runs with --no-browser`);
  }
  if (tool === "Bash") {
    const d = typeof ti.command === "string" ? decideCommand(ti.command, { ...ctx(), benchGo: env.PAI_BENCH_GO === "1" }) : ALLOW;
    if (d.decision === "allow" && typeof ti.command === "string") {
      const cmd = ti.command as string;
      const cfg = parseCommand(cmd).map((sg) => configMutationReason(sg.words, env, ctx().home)).find((r) => r);
      if (cfg) return deny(cfg);
      const why = nodeOnTypeScriptReason(cmd) ?? tscFileArgReason(cmd) ?? maskedProofReason(cmd) ?? tmpScratchReason(cmd) ?? forceAddReason(cmd, ctx().isIgnored ?? (() => false));
      if (why) return deny(why);
      if (isLocalWorker(env)) {
        const why2 = localRmReason(parseCommand(cmd), ctx().cwd);
        if (why2) return deny(why2);
      }
    }
    if (d.decision === "allow") {
      const raised = raiseWaitTimeout(ti);
      if (raised) return { decision: "allow", updatedInput: raised };
    }
    // A too-long tool timeout alone is clamped, not refused: models re-issued the same call and burned turns on denials.
    if (d.decision === "allow" && typeof ti.timeout === "number" && ti.timeout > MAX_FOREGROUND_SECS * 1000) {
      return { decision: "allow", updatedInput: { ...ti, timeout: MAX_FOREGROUND_SECS * 1000 }, context: CLAMP_NOTE };
    }
    return d;
  }
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const f = ti.file_path ?? ti.path;
    if (typeof f !== "string") return ALLOW;
    const c = ctx();
    const p = abs(f, c.cwd, c.home);
    const why = p && protectedPathReason(p, c.home);
    if (why) return deny(`edit of ${f} blocked: ${why}`);
    const local = p && isLocalWorker(env) && (tool === "Write" || tool === "Edit") ? localEditReason(tool, p, ti.content, c.worktreeRoot) : null;
    return local ? deny(local) : ALLOW;
  }
  return ALLOW;
}
