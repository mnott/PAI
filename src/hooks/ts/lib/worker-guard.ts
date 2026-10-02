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

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type GateDecision } from "./sleep-poll-gate.js";
import { decideWorkerGitGuard } from "./worker-git-guard.js";
import { isBrowserTool } from "../../../workers/browser-tools.js";
import { totalSleepSecs } from "../../../workers/status.js";
import { WAIT_RECIPE } from "../../../workers/wait-on.js";

export interface WorkerGuardInput {
  tool_name?: string;
  cwd?: string;
  tool_input?: { command?: string; file_path?: string; path?: string; timeout?: number };
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
  /** package.json `scripts.test` of the tree, null when unknown. */
  testScript: () => string | null;
}

interface Segment {
  words: string[];
  /** Redirection targets (`> f`, `>> f`, `2>f`). */
  redirects: string[];
}

const deny = (reason: string): GateDecision => ({ decision: "deny", reason });
const ALLOW: GateDecision = { decision: "allow" };

/** Split into segments; quotes group words, operators outside quotes split. */
export function parseCommand(command: string): Segment[] {
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

const WRAPPERS = new Set(["sudo", "command", "env", "time", "nohup", "exec", "builtin"]);

/** Drop env assignments and wrapper commands from the front. */
function stripPrefix(words: string[]): string[] {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || WRAPPERS.has(words[i]))) i++;
  return words.slice(i);
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

/** Live PAI/Claude config that tests and workers must not write. */
export function isLiveConfig(p: string, home: string): boolean {
  if (p === `${home}/.claude.json` || p === `${home}/.claude/settings.json`) return true;
  return dirname(p) === `${home}/.claude/pai` && /\.(ya?ml|json)$/.test(p);
}

const isTodo = (p: string): boolean => p === "Notes/TODO.md" || p.endsWith("/Notes/TODO.md");

function protectedPathReason(p: string, home: string): string | null {
  if (isTodo(p)) return "Notes/TODO.md is the orchestrator's: report what should change in your result instead";
  if (isLiveConfig(p, home)) return "live PAI/Claude config must not be written: tests use temp-dir copies";
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
const PATTERN_KILL_REASON =
  "pattern-based process kill blocked: kill only what you started, by PID (`cmd & echo $! > /tmp/x.pid`, then " +
  "`kill $(cat /tmp/x.pid)`), never by name or pattern; other workers' command lines contain your spec text";

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

  if ((cmd === "bash" || cmd === "sh" || cmd === "zsh") && args[0] === "-c" && args[1]) {
    return decideCommand(args[1], { ...ctx, cwd: st.cwd }, detached);
  }

  const pos = args.filter((a) => !isFlag(a));

  if (PATTERN_KILL.has(cmd) || (cmd === "xargs" && args.includes("kill")) || (cmd === "kill" && /pgrep|pidof/.test(args.join(" ")))) {
    return deny(PATTERN_KILL_REASON);
  }

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
    if (!ctx.inWorktree) {
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

export function decideWorkerGuard(
  input: WorkerGuardInput,
  env: Record<string, string | undefined>,
  ctx: () => WorkerGuardContext
): GateDecision {
  if (env.PAI_WORKER !== "1") return ALLOW;
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};

  if (env.PAI_WORKER_NO_BROWSER === "1" && tool?.startsWith("mcp__") && isBrowserTool(tool)) {
    return deny(`${tool} blocked: this worker runs with --no-browser`);
  }
  if (tool === "Bash") {
    if (typeof ti.timeout === "number" && ti.timeout > MAX_FOREGROUND_SECS * 1000) {
      return deny(`Bash timeout ${ti.timeout} ms blocked: ${WAIT_REASON_TAIL}`);
    }
    return typeof ti.command === "string" ? decideCommand(ti.command, ctx()) : ALLOW;
  }
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const f = ti.file_path ?? ti.path;
    if (typeof f !== "string") return ALLOW;
    const c = ctx();
    const p = abs(f, c.cwd, c.home);
    const why = p && protectedPathReason(p, c.home);
    return why ? deny(`edit of ${f} blocked: ${why}`) : ALLOW;
  }
  return ALLOW;
}
