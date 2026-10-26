/**
 * loop-guard.ts — repeat detection for worker tool calls.
 *
 * A loop is a problem only when it makes no progress. A call is a repeat of an
 * earlier one (since the last Edit/Write/MultiEdit/NotebookEdit) when its
 * command is >= 0.9 similar AND that earlier call's result was >= 0.9 similar
 * to the result of the call before it. The result is only known after the call,
 * so PreToolUse denies the next call when the last 4 similar calls all returned
 * similar results (PostToolUse records results via recordLoopResult). A similar
 * command whose result changes (polling, tailing, retry that succeeds, same
 * command over different files) is progress and never counts. Waiting verbs
 * and bounded sleeps are exempt. Unknown results count as similar. Runner runs
 * (see actionKey) reset when the worktree fingerprint changed since the previous
 * run of the key, so edits made through Bash count as progress too. The
 * fingerprint is content-based (tracked diff + non-empty non-dot untracked
 * files): touching a file or a `.loop-nudge` does not count, and a nudge-prefixed
 * repeat (`touch X && <blocked command>`) is the same command (LOOP-GUARD-EVASION).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { dropHeredocBodies } from "./heredoc.js";
import { HANG_MARKER } from "../../../workers/hang-probe.js";
import { redactSecrets } from "../../../utils/redact.js";
import { activeAntipattern, fillMessage, shippedAntipattern } from "./antipatterns.js";
import { dispositionOf } from "./antipattern-lifecycle.js";
import { ledgerResult, ledgerStep, type FailLedgerState } from "./fail-ledger.js";
import { loadBuildsConfig, runsDoor, splitSegments, type BuildsConfig } from "./build-gate.js";

// Thresholds and message texts live in antipatterns/tool-loop/*.yaml (user overrides in PAI_HOME/antipatterns).
// The exported constants are the shipped values; the step functions read the active pattern on every call.
const shipped = (id: string, key: string): number => shippedAntipattern(id).detector.params[key] as number;
const live = (id: string): { params: Record<string, unknown>; message: string } => {
  const ap = activeAntipattern(id);
  return { params: ap.detector.params, message: ap.message };
};
export const LOOP_MAX_REPEATS = shipped("growing-command", "max_repeats");
/** Identical writes of one file (same bytes) after which the write is denied and the session stopped; a rewrite costs nothing, so only a runaway loop trips it. */
export const IDENTICAL_WRITE_STOP_AT = shipped("identical-write", "stop_at");
/** Reverts of one file (a Write whose content equals an earlier, not the current, version) at which a note is added / the write is denied and the session stopped. */
export const REVERT_NOTE_AT = shipped("revert", "note_at");
export const REVERT_STOP_AT = shipped("revert", "stop_at");
/** Denials of one cluster after which the session is stopped (the 7th attempt). */
export const LOOP_STOP_DENIALS = shipped("growing-command", "stop_denials");
/** Consecutive same-template read-only Bash calls without a worktree change after which the next one is denied (env PAI_LOOP_READ_STREAK overrides). */
export const LOOP_READ_STREAK = Number(process.env.PAI_LOOP_READ_STREAK) > 0 ? Number(process.env.PAI_LOOP_READ_STREAK) : 15;
/** Piecewise-read denials in a row after which the session is stopped (the 2nd denial after the first). */
export const LOOP_READ_STOP_DENIALS = 3;
const SIMILARITY = 0.9;
const READ_OVERLAP = 0.8;
const RESULT_CHARS = 2000;
const WINDOW_CAP = 64;
/** Last results kept for echo (read-only calls only): entries and chars each. */
const LAST_CAP = 8;
const LAST_CHARS = 8000;
/** Shipped defaults of workers.loopGuard; the hook passes the configured values. */
export const DEFAULT_ECHO = { echoLines: 40, echoChars: 3000, echoRunnerLines: 40 };
export type EchoConfig = { echoLines: number; echoChars: number; echoRunnerLines?: number };

const SELF = "If your part is done, commit and write your R report. If you are stuck, report the blocker in R x= (or use pai worker help if available).";
/** Non-blocking note after the 2nd identical repeat. */
export const LOOP_NUDGE = shippedAntipattern("growing-command").detector.params.note_message as string;
export const LOOP_DENY_REASON = fillMessage(shippedAntipattern("growing-command").message, { count: LOOP_MAX_REPEATS });

const HANG_SUFFIX = " This command hung before (see the hang probe line in its output for where); running it unchanged will hang again. Fix the code at that location first.";

/** True when an earlier result of the cluster (window indexes) carried a hang-probe diagnosis. */
function hungBefore(state: LoopState, idx: number[]): boolean {
  return idx.some((i) => state.outs?.[i]?.includes(HANG_MARKER));
}

export function loopDenyReason(tool = "Bash", count = LOOP_MAX_REPEATS): string {
  const { params, message } = live("growing-command");
  return tool === "Bash"
    ? fillMessage(message, { count: params.max_repeats as number })
    : fillMessage(params.tool_message as string, { tool, count });
}

export interface LoopState {
  /** File -> key of its last Write/Edit and how many times in a row that exact call was made; a Read in between does not reset it. */
  writes?: Record<string, { key: string; n: number; /** Keys of the last versions written (oldest first, current last). */ seen?: string[]; /** Writes that went back to an earlier version. */ reverts?: number }>;
  /** File -> Writes since the last Read/Bash/Grep of anything: count, distinct content hashes, and whether distinct-rewrites already fired. */
  rewrites?: Record<string, { n: number; hashes: string[]; fired?: boolean }>;
  /** Streak counters that survive edits: Writes of new files since the last Read/Bash/Grep/Glob, and Reads of missing paths in a row. */
  streaks?: { newFiles?: { n: number; fired?: boolean }; missing?: number };
  /** Call keys (`Tool\tnormalised input`) since the last edit, oldest first. */
  window: string[];
  /** Normalised result text per window entry; null while unknown. */
  outs?: Array<string | null>;
  /** Window key -> raw last result (secret lines masked) of a read-only call, handed back when a repeat is denied. */
  last?: Record<string, string>;
  /** Action key -> tail of the last output (secret lines masked) of a runner command, handed back when a re-run is denied. */
  runLast?: Record<string, string>;
  /** Denials per cluster head since the last edit. */
  denials?: Record<string, number>;
  /** Runner invocations per action key since the last edit (see actionKey). */
  runs?: Record<string, number>;
  /** Worktree fingerprint at the last counted run per action key; a different one is progress. */
  prints?: Record<string, string>;
  /** Window key -> ms timestamp of the first "still running" result of a polling call (see isWaitResult). */
  waits?: Record<string, number>;
  /** Window key -> ms timestamp of the first call of a build-door poll (see isPollCommand); bounded by WAIT_CAP_MS. */
  polls?: Record<string, number>;
  /** Poll key -> consecutive finished (non-waiting) results of a build-door poll; an instant door failure is not a wait. */
  pollDone?: Record<string, number>;
  /** Streak of read-only Bash calls sharing one template and file set while the worktree stayed unchanged. */
  reads?: { key: string; files: string; print: string | null; n: number; denials: number };
  /** Per-run FAIL ledger (workers.failLedger); absent while the experiment is off. */
  fail?: FailLedgerState;
}

/** Total polling time per command key after which a "still running" helper is treated as an ordinary repeat again. */
export const WAIT_CAP_MS = 45 * 60_000;
const POLL_PROGRESS = /queue|progress|waiting|running|building|attached|position/i;
const WAIT_TEXT = /still running|call again|in progress|not (?:yet )?(?:done|finished|ready)/i;

function exitCodeOf(response: unknown): number | null {
  if (typeof response === "string") {
    const m = /^Exit code (\d+)/m.exec(response);
    return m ? Number(m[1]) : null;
  }
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    for (const k of ["exitCode", "exit_code", "returncode", "code"]) if (typeof r[k] === "number") return r[k] as number;
  }
  return null;
}

/**
 * A polling helper's "come back later" result: exit code 3 (when the code is known) with output saying it is still
 * running / call again / in progress. Such a call is a wait, not a repeat.
 */
export function isWaitResult(response: unknown): boolean {
  const code = exitCodeOf(response);
  return (code === 3 || code === null) && WAIT_TEXT.test(resultSig(response));
}

const doorCache = new Map<string, BuildsConfig | null>();
function doorsAt(dir: string): BuildsConfig | null {
  const d = resolve(dir);
  if (!doorCache.has(d)) doorCache.set(d, loadBuildsConfig(d));
  return doorCache.get(d) ?? null;
}

const POLL_VERB = /^(?:pai\s+build\s+(?:run|lock)|pai\s+worker\s+wait[\w-]*)\b/;

/**
 * A poll waits for something else: anywhere in the command line (cd prefixes, pipes, && chains) it invokes a build
 * door registered in the repo's `.pai/builds.yaml` with `--wait`, or `pai build run|lock`, or `pai worker wait*`.
 */
export function isPollCommand(command: string, cwd: string = process.cwd()): boolean {
  let dir = cwd;
  for (const seg of splitSegments(command)) {
    const ws = seg.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, "")).filter(Boolean);
    if (ws[0] === "cd" && ws[1]) {
      dir = isAbsolute(ws[1]) ? ws[1] : resolve(dir, ws[1]);
      continue;
    }
    if (POLL_VERB.test(ws.join(" ").replace(/^(?:[A-Za-z_]\w*=\S*\s+|nohup\s+)+/, ""))) return true;
    if (!ws.includes("--wait")) continue;
    if (runsDoor(ws, dir, doorsAt(dir))) return true;
  }
  return false;
}

/** Runs of one action key without an edit at which the call is denied / the session stopped. */
export const RUN_DENY_AT = shipped("repeated-failure", "deny_at");
export const RUN_STOP_AT = shipped("repeated-failure", "stop_at");

const RUNNER = /^(?:npx\s+|bunx\s+|pnpm (?:exec\s+)?|yarn\s+)?(vitest|jest|pytest|tsdown|tsc|xcodebuild|npm (?:run )?test|npm run build|swift test|cargo test|go test|bun test)\b\s*(.*)$/;

/**
 * Action key of a Bash command: the test/build runner and its target files, with nohup, env prefixes,
 * `timeout N`, redirections, backgrounding, pid files, waits and flags removed. Null when the command runs no runner.
 */
export function actionKey(command: string): string | null {
  const bare = command.replace(/\d*>>?\s*&?[^\s;&|]+/g, " ").replace(/<\s*[^\s;&|]+/g, " ");
  for (const raw of bare.split(/&&|\|\||[;|&\n]/)) {
    let seg = raw.replace(/["']/g, "").trim();
    for (;;) {
      const next = seg
        .replace(/^(?:[A-Za-z_]\w*=\S*\s+)/, "")
        .replace(/^nohup\s+/, "")
        .replace(/^(?:timeout|gtimeout)\s+(?:-\S+\s+)*\d+\w*\s+/, "")
        .replace(/^cd\s+\S+\s*/, "");
      if (next === seg) break;
      seg = next;
    }
    const m = RUNNER.exec(seg);
    if (!m) continue;
    const args = m[2].split(/\s+/).filter((a) => a && !a.startsWith("-") && a !== "run" && a !== "test");
    return [m[1], ...[...new Set(args)].sort()].join(" ");
  }
  return null;
}

/** Untracked files up to this size are hashed by content; larger ones by size + mtime. */
const FP_FULL_READ_BYTES = 256 * 1024;
/** Content bytes read per fingerprint across all untracked files; past it files are hashed by size + mtime. */
const FP_TOTAL_BYTES = 4 * 1024 * 1024;

/**
 * Cheap fingerprint of the worktree CONTENT: the diff of tracked files against HEAD plus the content of untracked
 * files that are not ignored, not empty and not dot-files. A touch (mtime-only change), an empty file or a dot-file
 * nudge does not change it, so creating `.loop-nudge` does not get a repeated command past the guard.
 * Null outside a git worktree or on error.
 */
export function worktreeFingerprint(cwd: string): string | null {
  try {
    const git = (args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    const root = git(["rev-parse", "--show-toplevel"]).trim();
    const h = createHash("sha1");
    // no commits yet: HEAD does not exist, so every tracked file is untracked content
    let hasHead = true;
    try {
      git(["rev-parse", "--verify", "HEAD"]);
    } catch {
      hasHead = false;
    }
    if (hasHead) h.update(git(["diff", "HEAD", "--no-color", "--no-ext-diff"]));
    const untracked = git(["ls-files", "--others", "--exclude-standard"]);
    let budget = FP_TOTAL_BYTES;
    for (const p of untracked.split("\n")) {
      if (!p || p.startsWith(".") || p.includes("/.")) continue; // dot-files and nudges do not count
      try {
        const file = join(root, p);
        const st = statSync(file);
        if (!st.isFile() || !st.size) continue; // an empty file is no change
        if (st.size > FP_FULL_READ_BYTES || st.size > budget) {
          // too big to read on every call: size + mtime still change when the file does
          h.update(`${p}\0${st.size}\0${st.mtimeMs}`);
          continue;
        }
        budget -= st.size;
        h.update(`${p}\0`).update(readFileSync(file));
      } catch {
        // unreadable path: skip it
      }
    }
    // staged-but-uncommitted content is invisible to `git diff HEAD`
    if (hasHead) h.update(git(["diff", "--cached", "--no-color", "--no-ext-diff"]));
    return h.digest("hex");
  } catch {
    return null;
  }
}

/** The command itself edits files before it runs the runner (the fingerprint is taken before the command runs). */
function inlineEdit(command: string): boolean {
  return /\b(?:sed|perl)\s+(?:-\w+\s+)*-i|\bgit apply\b|\bpatch\s+-?\w*\s*-?p\d|\btee\s+(?!\/tmp)\S|(?:^|[;&|]\s*)cat\s*>>?\s*(?!\/tmp)[\w.]/.test(command.split(/&&|;|\|/).slice(0, -1).join(";") || "");
}

const READ_VERB = /^(?:sed|head|tail|cat|grep|egrep|rg|awk|nl|wc|od|echo|printf|true)$/;

/**
 * Sorted file operands of a read-only command (sed -n / head / tail / cat / grep / awk print on files, joined by
 * ; && | and echo separators), or null when the command is not read-only or names no file.
 */
export function readOnlyFiles(command: string): string | null {
  if (/\bsed\s+(?:-\w+\s+)*-i|\bawk\b[^;|]*\b(?:system|getline)\b|(?:^|[^\d&])>>?\s*(?!\/dev\/null|&)/.test(command.replace(/\d?>&\d/g, ""))) return null;
  const files = new Set<string>();
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const ws = seg.replace(/["']/g, " ").split(/\s+/).filter(Boolean);
    if (!ws.length) continue;
    if (!READ_VERB.test(ws[0].replace(/^.*\//, ""))) return null;
    if (ws[0] === "echo" || ws[0] === "printf") continue;
    for (const w of ws.slice(1)) if (!w.startsWith("-") && !/^[\d,;$]+[pP]?$/.test(w) && /[\w.]\.\w+$|\//.test(w) && !/^\/.*\/[pPd]?$/.test(w)) files.add(w);
  }
  return files.size ? [...files].sort().join(" ") : null;
}

export function emptyLoopState(): LoopState {
  return { window: [] };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Bash", "Grep"]);
const TMP_PATH = /(?:\/private)?\/tmp\/[^\s'";|&<>)]*|\$\{?TMPDIR\}?(?:\/[^\s'";|&<>)]*)?/g;
const WAIT_VERB = /\bpai worker (?:wait|wait-on|wait-url|wait-file)\b/;

function exempt(command: string): boolean {
  if (WAIT_VERB.test(command)) return true;
  // only a command that starts by sleeping is a wait; a sleep buried in a longer command is a pause inside a retry
  const m = /^\s*sleep (\d+(?:\.\d+)?)\b/.exec(command);
  return !!m && Number(m[1]) <= 60;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Token set of a command: quotes stripped, temp paths -> TMP, digit runs -> NUM, split on whitespace and shell operators. */
function tokenSet(text: string): string[] {
  const toks = text
    .replace(TMP_PATH, " TMP ")
    .replace(/["']/g, "")
    .split(/[\s;|&<>(){}]+/)
    .filter(Boolean)
    .map((t) => t.replace(/\d+/g, "NUM"));
  return [...new Set(toks)].sort();
}

/** Normalised command text; equal for commands that differ only in numbers, temp names, quoting or spacing. */
export function loopKey(command: string): string {
  return tokenSet(command).join(" ");
}

/**
 * Jaccard on token sets, except overlap-coefficient (intersection / smaller set) when both sets have >= 3
 * tokens: adding a flag or a redirect to a command must not hide it (a Jaccard of 5 vs 7 tokens is 0.71),
 * while `git status` vs `git log` (2 tokens each) and unrelated longer commands stay far apart.
 */
function tokenSimilarity(a: string, b: string): number {
  const x = a.split(" ");
  const y = new Set(b.split(" "));
  const inter = x.filter((t) => y.has(t)).length;
  const small = Math.min(x.length, y.size);
  return inter / (small >= 3 ? small : x.length + y.size - inter || 1);
}

function readRange(input: Record<string, unknown>): { start: number; end: number } {
  const off = typeof input.offset === "number" && input.offset > 0 ? input.offset : 1;
  const lim = typeof input.limit === "number" && input.limit > 0 ? input.limit : Infinity;
  return { start: off, end: off + lim - 1 };
}

function parseRead(body: string): { file: string; start: number; end: number } | null {
  const m = /^Read@(.*)#(\d+)-(\d+|inf)$/s.exec(body);
  return m ? { file: m[1], start: Number(m[2]), end: m[3] === "inf" ? Infinity : Number(m[3]) } : null;
}

/** Share of the new call's lines already covered by an earlier call (same file), 0 for different files. */
function readCoverage(prev: string, cur: string): number {
  const p = parseRead(prev);
  const c = parseRead(cur);
  if (!p || !c || p.file !== c.file) return 0;
  const cap = (n: number) => Math.min(n, 1e9); // no limit = to the end of the file
  const inter = cap(Math.min(p.end, c.end)) - Math.max(p.start, c.start) + 1;
  return inter > 0 ? inter / (cap(c.end) - c.start + 1) : 0;
}

/** A leading nudge that only touches/creates a file: `touch X &&`, `: > X &&`, `echo > X &&`. */
const NUDGE_PREFIX = /^\s*(?:touch\s+\S+|:\s*>?\s*\S+|echo\s*>\s*\S+)\s*&&\s*/;

/**
 * True when `command` is a repeat of `prev` hidden behind a file-touching nudge prefix: stripping the prefix
 * leaves a command whose key equals the blocked one. Such a call counts as the same command (LOOP-GUARD-EVASION).
 */
export function loopGuardEvasion(command: string, prev: string): boolean {
  const m = NUDGE_PREFIX.exec(command);
  return !!m && loopKey(command.slice(m[0].length)) === loopKey(prev);
}

/** Window key of a call, or null when it is not trackable or is exempt. Display text is the part after the tab. */
export function callKey(tool: string, input: string | Record<string, unknown> | undefined): string | null {
  if (tool === "Bash") {
    let c = typeof input === "string" ? input : (input as { command?: unknown } | undefined)?.command;
    // a nudge prefix hides the command it repeats: compare the command behind it
    if (typeof c === "string") {
      const m = NUDGE_PREFIX.exec(c);
      if (m) c = c.slice(m[0].length);
    }
    return typeof c === "string" && c.trim() && !exempt(c) ? `Bash\t${loopKey(c)}` : null;
  }
  if (!tool || !input || typeof input !== "object") return null;
  if (tool === "Read") {
    const { start, end } = readRange(input);
    return `Read\tRead@${String(input.file_path ?? "")}#${start}-${Number.isFinite(end) ? end : "inf"}`;
  }
  if (tool === "Write") {
    // a rewrite with different content is a different call; only the same file with the same bytes repeats
    const content = typeof input.content === "string" ? input.content : stable(input.content);
    const hash = createHash("sha1").update(content).digest("hex").slice(0, 12);
    return `Write\t${String(input.file_path ?? "")}#${hash}`;
  }
  return `${tool}\t${tokenSet(stable(input)).join(" ")}`;
}

/** Back-compat name for the non-Bash window key. */
export function toolKey(tool: string, input: Record<string, unknown>): string {
  return callKey(tool, input) ?? "";
}

function keysSimilarOneWay(a: string, b: string): boolean {
  const [ta, ba] = a.split("\t");
  const [tb, bb] = b.split("\t");
  if (ta !== tb) return false;
  return ta === "Read" ? readCoverage(ba, bb) >= READ_OVERLAP : tokenSimilarity(ba, bb) >= SIMILARITY;
}

const keysSimilar = (a: string, b: string) => keysSimilarOneWay(a, b) || keysSimilarOneWay(b, a);

/** Window indexes of the cluster the new key joins: everything similar to it, and similar to those (so a full-file Read or a bare `vitest run` ties its narrower variants together). */
function clusterOf(window: string[], key: string): number[] {
  const members = new Set<number>();
  const frontier = [key];
  while (frontier.length) {
    const cur = frontier.pop() as string;
    window.forEach((k, i) => {
      if (!members.has(i) && keysSimilar(k, cur)) {
        members.add(i);
        frontier.push(k);
      }
    });
  }
  return [...members].sort((x, y) => x - y);
}

/** Tool result as comparable text: temp paths collapsed, whitespace trimmed, head and tail of long text. */
export function resultSig(response: unknown): string {
  let text: string;
  if (typeof response === "string") text = response;
  else if (response && typeof response === "object" && ("stdout" in response || "stderr" in response)) {
    const r = response as { stdout?: unknown; stderr?: unknown };
    text = `${typeof r.stdout === "string" ? r.stdout : ""}\n${typeof r.stderr === "string" ? r.stderr : ""}`;
  } else text = stable(response);
  text = text.replace(TMP_PATH, "TMP").replace(/\s+/g, " ").trim();
  // head and tail: a growing log keeps its head, a progress line changes its tail
  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS / 2)} ${text.slice(-RESULT_CHARS / 2)}` : text;
}

function resultsSimilar(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return true;
  if (a === b) return true;
  const x = new Set(a.split(" "));
  const y = new Set(b.split(" "));
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter) >= SIMILARITY;
}

/** Result text with secret values replaced by [REDACTED] (labels kept); see src/utils/redact.ts. */
export function maskSecrets(text: string): string {
  return redactSecrets(text);
}

function rawText(response: unknown): string {
  if (typeof response === "string") return response;
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    if ("stdout" in r || "stderr" in r) return [r.stdout, r.stderr].filter((x) => typeof x === "string" && x).join("\n");
    const content = (r.file as { content?: unknown } | undefined)?.content ?? r.content;
    if (typeof content === "string") return content;
  }
  return stable(response);
}

/** A call whose output the guard may hand back: Read, Grep, Glob, or a Bash command classified read-only. */
function echoable(tool: string, input: string | Record<string, unknown> | undefined): boolean {
  if (tool === "Bash") return typeof input === "string" && readOnlyFiles(input) !== null;
  return tool === "Read" || tool === "Grep" || tool === "Glob";
}

/** Output trimmed to the first `lines` lines and `chars` characters, with a note when cut. */
function trimEcho(text: string, cfg: EchoConfig): string {
  const lines = text.split("\n");
  let out = lines.slice(0, cfg.echoLines).join("\n");
  let cut = lines.length > cfg.echoLines;
  if (out.length > cfg.echoChars) {
    out = out.slice(0, cfg.echoChars);
    cut = true;
  }
  return cut ? `${out}\n[...trimmed]` : out;
}

/** Output trimmed to its last `lines` lines and `chars` characters (the end is where runners print failures), with a note when cut. */
function trimTail(text: string, lines: number, chars: number): string {
  const all = text.replace(/\n+$/, "").split("\n");
  let out = all.slice(-lines).join("\n");
  let cut = all.length > lines;
  if (out.length > chars) {
    out = out.slice(out.length - chars);
    cut = true;
  }
  return cut ? `[trimmed...]\n${out}` : out;
}

/** PostToolUse: attaches the call's result to its window entry. An edit clears the state. */
export function recordLoopResult(state: LoopState, tool: string, input: string | Record<string, unknown> | undefined, response: unknown, now = Date.now(), ledger = false): LoopState {
  const core = recordLoopResultCore(state, tool, input, response, now);
  if (!ledger) return core;
  // an edit resets the window and drops everything not carried over by hand: the ledger survives
  const next = core.fail === state.fail ? core : { ...core, fail: state.fail };
  const text = rawText(response);
  const m = /Exit code (\d+)/.exec(text);
  const code = exitCodeOf(response) ?? (m ? Number(m[1]) : null);
  return ledgerResult(next, tool, bashCommand(input), text, code, typeof response === "string" && response.startsWith("error:"));
}

function recordLoopResultCore(state: LoopState, tool: string, input: string | Record<string, unknown> | undefined, response: unknown, now = Date.now()): LoopState {
  const key = callKey(tool, input);
  if (EDIT_TOOLS.has(tool) && (key === null || state.window[state.window.length - 1] !== key)) return key === null ? { ...emptyLoopState(), writes: state.writes, rewrites: state.rewrites, streaks: state.streaks } : { ...emptyLoopState(), writes: state.writes, rewrites: state.rewrites, streaks: state.streaks, window: [key], outs: [null] };
  if (key !== null && tool === "Bash") {
    const waits = { ...(state.waits ?? {}) };
    const pd = { ...(state.pollDone ?? {}) };
    if (key in (state.polls ?? {})) {
      if (isWaitResult(response) || POLL_PROGRESS.test(resultSig(response))) delete pd[key];
      else pd[key] = (pd[key] ?? 0) + 1;
      state = { ...state, pollDone: pd };
    }
    if (isWaitResult(response)) return { ...state, waits: { ...waits, [key]: waits[key] ?? now } };
    if (key in waits) {
      delete waits[key];
      state = { ...state, waits };
    }
  }
  const last = state.window.length - 1;
  if (key === null || last < 0 || state.window[last] !== key) return state;
  const outs = [...(state.outs ?? [])];
  while (outs.length < state.window.length) outs.push(null);
  outs[last] = resultSig(response);
  const cmd = tool === "Bash" ? (typeof input === "string" ? input : (input as { command?: unknown } | undefined)?.command) : undefined;
  const ak = typeof cmd === "string" ? actionKey(cmd) : null;
  if (ak !== null) {
    const keptRuns = Object.entries(state.runLast ?? {}).filter(([k]) => k !== ak).slice(-(LAST_CAP - 1));
    const tail = maskSecrets(rawText(response)).slice(-LAST_CHARS);
    return { ...state, outs, runLast: Object.fromEntries([...keptRuns, [ak, tail]]) };
  }
  if (!echoable(tool, input)) return { ...state, outs };
  const kept = Object.entries(state.last ?? {}).filter(([k]) => k !== key).slice(-(LAST_CAP - 1));
  const text = maskSecrets(rawText(response)).slice(0, LAST_CHARS);
  return { ...state, outs, last: Object.fromEntries([...kept, [key, text]]) };
}

export interface LoopStep {
  state: LoopState;
  deny: boolean;
  /** True when the same cluster has now been denied LOOP_STOP_DENIALS times: end the session. */
  stop?: boolean;
  /** Display text of the cluster head. */
  key?: string;
  /** Similar attempts of this cluster including this one. */
  count?: number;
  /** Deny message when it differs from loopDenyReason (the no-progress rule). */
  reason?: string;
  /** Non-blocking advisory (the call is allowed): the 2nd identical repeat with an unchanged result. */
  note?: string;
  /** True when this call is a nudge-prefixed repeat of a command the guard already blocked (LOOP-GUARD-EVASION). */
  evasion?: boolean;
  /** The anti-pattern that produced a deny or note; absent for a stop no pattern covers (a candidate). */
  id?: string;
  /** Set when the pattern is in monitor mode: the step is neutralised (no deny, stop or note) and this is what it would have done. */
  monitored?: { action: "note" | "deny" | "stop" };
}

function runnerEcho(prior: string | undefined, echo: EchoConfig): string {
  const lines = echo.echoRunnerLines ?? DEFAULT_ECHO.echoRunnerLines;
  if (!prior || lines <= 0 || echo.echoChars <= 0) return "";
  return ` Its last output ended with:\n${trimTail(prior, lines, echo.echoChars)}\nRead the failure above and change code or the test before running it again.`;
}

function hangNote(state: LoopState, command: string): string {
  const key = callKey("Bash", command);
  return key !== null && hungBefore(state, clusterOf(state.window, key)) ? HANG_SUFFIX : "";
}

/** Counts one write of `file` (content hash) in `rewrites`; the distinct-rewrites note when the thresholds are reached, once per file. `held`: another note of the step takes precedence, the firing waits. */
function countRewrite(rewrites: NonNullable<LoopState["rewrites"]>, file: string, hash: string, held: boolean): string | undefined {
  const dr = live("distinct-rewrites");
  const cur = rewrites[file] ?? { n: 0, hashes: [] };
  const next = { n: cur.n + 1, hashes: cur.hashes.includes(hash) ? cur.hashes : [...cur.hashes, hash], fired: cur.fired };
  rewrites[file] = next;
  if (next.fired || held || next.n < (dr.params.same_file_writes as number) || next.hashes.length < (dr.params.distinct_versions as number)) return undefined;
  next.fired = true;
  return fillMessage(dr.message, { file, n: next.n });
}

// commands whose segments may make up a pure file write (`mkdir -p d && cat > d/f <<EOF`)
const WRITE_WORDS = new Set(["cat", "tee", "echo", "printf", "true", ":", "cd", "mkdir"]);
const REDIRECT = /(?:^|[\s\d])>>?\s*(?!&)([^\s;&|<>]+)/g;
const TEE = /\btee\s+(?:-\w+\s+)*([^\s;&|<>-][^\s;&|<>]*)/g;

/**
 * The files a Bash call writes when it does nothing else: every segment is cat/tee/echo/printf/cd/mkdir or a bare
 * redirect, and at least one redirect (`> f`, `>> f`) or `tee f` names a file. A call that also runs something
 * (a test, node f, grep) returns null: its result is new information, not a bare write.
 */
export function bashWriteTargets(command: string): string[] | null {
  const body = dropHeredocBodies(command).replace(/<<-?\s*(?:'[^']+'|"[^"]+"|\w+)/g, " ");
  const targets = new Set<string>();
  for (const m of body.matchAll(REDIRECT)) if (!/^\/dev\/(?:null|stdout|stderr)$/.test(m[1])) targets.add(m[1]);
  for (const m of body.matchAll(TEE)) targets.add(m[1]);
  if (!targets.size) return null;
  for (const seg of body.split(/[;&|\n]+/)) {
    const first = seg.trim().split(/\s+/)[0] ?? "";
    if (first && !WRITE_WORDS.has(first) && !/^\d?>>?/.test(first)) return null;
  }
  return [...targets];
}

const bashCommand = (input: string | Record<string, unknown> | undefined): string | undefined => {
  const c = typeof input === "string" ? input : (input as { command?: unknown } | undefined)?.command;
  return typeof c === "string" ? c : undefined;
};

/** Next state and whether this tool call is a loop repeat to deny. `input` is the Bash command or the tool input object. */
function stepLoopGuardRaw(state: LoopState, tool: string, input?: string | Record<string, unknown>, fingerprint?: string | null, now = Date.now(), cwd?: string, echo: EchoConfig = DEFAULT_ECHO): LoopStep {
  if (EDIT_TOOLS.has(tool)) {
    const ek = callKey(tool, input);
    if (ek === null) return { state: { ...emptyLoopState(), writes: state.writes, rewrites: state.rewrites, streaks: state.streaks }, deny: false };
    // an identical rewrite is allowed (it costs nothing) and told plainly; only a runaway count is stopped
    const file = String((input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).notebook_path ?? "");
    const prev = state.writes?.[file];
    const n = prev && prev.key === ek ? prev.n + 1 : 1;
    // a Write back to an earlier version (not the current one) is a revert: A,B,A,B,... never repeats the current content
    const revert = tool === "Write" && !!prev && prev.key !== ek && !!prev.seen?.includes(ek);
    const reverts = (prev?.reverts ?? 0) + (revert ? 1 : 0);
    const rv = live("revert");
    const iw = live("identical-write");
    const seen = [...(prev?.seen ?? []).filter((k) => k !== ek), ...(tool === "Write" ? [ek] : [])].slice(-(rv.params.seen_cap as number));
    const writes = { ...(state.writes ?? {}), [file]: { key: ek, n, seen, reverts } };
    for (const k of Object.keys(writes).slice(0, -LAST_CAP * 8)) delete writes[k];
    if (n >= (iw.params.stop_at as number))
      return {
        state: { ...emptyLoopState(), writes },
        deny: true,
        stop: true,
        id: "identical-write",
        key: ek.split("\t")[1],
        count: n,
        reason: fillMessage(iw.params.stop_message as string, { file, n }),
      };
    if (reverts >= (rv.params.stop_at as number))
      return {
        state: { ...emptyLoopState(), writes },
        deny: true,
        stop: true,
        id: "revert",
        key: ek.split("\t")[1],
        count: reverts,
        reason: fillMessage(rv.params.stop_message as string, { file, n: reverts }),
      };
    const ordinal = `${reverts}${reverts % 10 === 3 && reverts !== 13 ? "rd" : reverts % 10 === 2 && reverts !== 12 ? "nd" : "th"}`;
    const revertNote = revert && reverts >= (rv.params.note_at as number) ? fillMessage(rv.message, { file, ordinal, n: reverts }) : undefined;
    // distinct-rewrites: many different Writes of one file with no tool result bringing new information in between
    const rewrites = { ...(state.rewrites ?? {}) };
    let rewriteNote: string | undefined;
    // the revert / identical-write notes of the same step take precedence; the firing waits for the next step
    const idNote = revertNote ?? (n >= (iw.params.note_at as number) ? fillMessage(iw.message, { file, tool, n }) : undefined);
    if (tool === "Write") {
      rewriteNote = countRewrite(rewrites, file, ek.slice(ek.lastIndexOf("#") + 1), !!idNote);
      for (const k of Object.keys(rewrites).slice(0, -LAST_CAP * 8)) delete rewrites[k];
    }
    const note = idNote ?? rewriteNote;
    return { state: { ...emptyLoopState(), writes, rewrites, window: [ek], outs: [null] }, deny: false, ...(note ? { note, id: idNote ? (revertNote ? "revert" : "identical-write") : "distinct-rewrites", ...(idNote ? {} : { key: file }) } : {}) };
  }
  if (tool === "Bash") {
    const c = typeof input === "string" ? input : (input as { command?: unknown } | undefined)?.command;
    const pk = typeof c === "string" ? callKey(tool, c) : null;
    if (pk !== null && isPollCommand(c as string, cwd)) {
      const since = state.polls?.[pk] ?? now;
      const next = { ...state, polls: { ...(state.polls ?? {}), [pk]: since } };
      const done = state.pollDone?.[pk] ?? 0;
      if (done >= RUN_DENY_AT) {
        return {
          state: next,
          deny: true,
          stop: done >= RUN_STOP_AT,
          key: pk.split("\t")[1],
          count: done + 1,
          reason: `loop guard: this build-door call returned ${done} times in a row with a finished result and no queue/progress output; it is not waiting for anything, the result will not change. Read the failure, change code, or report the blocker. ${SELF}`,
        };
      }
      if (now - since < WAIT_CAP_MS) return { state: next, deny: false };
      return {
        state: next,
        deny: true,
        key: pk.split("\t")[1],
        reason: `loop guard: this command has been polled for over ${WAIT_CAP_MS / 60_000} minutes (wait cap per command). It is not finishing; check what it is waiting on or report the blocker. ${SELF}`,
      };
    }
  }
  if (tool === "Bash") {
    // the previous result of this command said "still running": polling is waiting, bounded by WAIT_CAP_MS
    const wk = callKey(tool, input);
    const since = wk === null ? undefined : state.waits?.[wk];
    if (wk !== null && since !== undefined) {
      if (now - since < WAIT_CAP_MS) return { state, deny: false };
      return {
        state,
        deny: true,
        key: wk.split("\t")[1],
        reason: `loop guard: this command has reported "still running" for over ${WAIT_CAP_MS / 60_000} minutes (wait cap per command). It is not finishing; check what it is waiting on or report the blocker. ${SELF}`,
      };
    }
  }
  if (tool === "Bash") {
    const rc = typeof input === "string" ? input : (input as { command?: unknown } | undefined)?.command;
    const rk = typeof rc === "string" ? callKey(tool, rc) : null;
    const files = rk !== null ? readOnlyFiles(rc as string) : null;
    if (rk !== null && files !== null) {
      const print = fingerprint ?? null;
      const prev = state.reads;
      const same = !!prev && prev.key === rk && prev.files === files && prev.print === print;
      const n = same ? prev.n + 1 : 1;
      if (same && prev.n >= LOOP_READ_STREAK) {
        const denials = prev.denials + 1;
        return {
          state: { ...state, reads: { ...prev, denials } },
          deny: true,
          stop: denials >= LOOP_READ_STOP_DENIALS,
          key: rk.split("\t")[1],
          count: prev.n,
          reason: `loop guard: You are reading ${files} piece by piece (${prev.n} calls, no edits). Read the whole file once with the Read tool (or cat), then act. ${SELF}`,
        };
      }
      state = { ...state, reads: { key: rk, files, print, n, denials: same ? prev.denials : 0 } };
    } else if (state.reads) state = { ...state, reads: undefined };
  }
  if (tool === "Bash") {
    const cmd = typeof input === "string" ? input : (input as { command?: unknown } | undefined)?.command;
    const ak = typeof cmd === "string" ? actionKey(cmd) : null;
    if (ak !== null) {
      // the worktree changed since the previous run of this key (Bash edit, git apply, codegen): progress
      const changed = inlineEdit(cmd as string) || !!fingerprint && state.prints?.[ak] !== undefined && state.prints[ak] !== fingerprint;
      const n = (changed ? 0 : (state.runs?.[ak] ?? 0)) + 1;
      state = { ...state, runs: { ...(state.runs ?? {}), [ak]: n }, ...(fingerprint ? { prints: { ...(state.prints ?? {}), [ak]: fingerprint } } : {}) };
      const rf = live("repeated-failure");
      if (n >= (rf.params.deny_at as number))
        return {
          state,
          deny: true,
          stop: n >= (rf.params.stop_at as number),
          id: "repeated-failure",
          key: ak,
          count: n,
          reason: fillMessage(rf.message, { key: ak, deny_at: rf.params.deny_at as number, hang: hangNote(state, cmd as string), echo: runnerEcho(state.runLast?.[ak], echo) }),
        };
    }
  }
  const key = callKey(tool, input);
  if (key === null) return { state, deny: false };
  const idx = clusterOf(state.window, key);
  const gc = live("growing-command").params;
  const maxRepeats = gc.max_repeats as number;
  const lastN = idx.slice(-maxRepeats);
  const outs = state.outs ?? [];
  const stalled = lastN.length >= maxRepeats && lastN.every((i, n) => n === 0 || resultsSimilar(outs[lastN[n - 1]], outs[i]));
  if (stalled) {
    const head = state.window[idx[0]];
    const denials = { ...(state.denials ?? {}) };
    denials[head] = (denials[head] ?? 0) + 1;
    const cmd = tool === "Bash" ? (typeof input === "string" ? input : (input as { command?: unknown } | undefined)?.command) : undefined;
    const prior = state.last?.[state.window[idx[idx.length - 1]]];
    const echoed = prior && echo.echoLines > 0 && echo.echoChars > 0 ? ` Its last output was:\n${trimEcho(prior, echo)}\nUse this output; do not run it again.` : "";
    const hung = hungBefore(state, idx);
    return {
      state: { ...state, denials },
      deny: true,
      stop: denials[head] >= (gc.stop_denials as number),
      id: "growing-command",
      evasion: typeof cmd === "string" && loopGuardEvasion(cmd, head.split("\t")[1] ?? ""),
      reason: hung || echoed ? `${loopDenyReason(tool)}${hung ? HANG_SUFFIX : ""}${echoed}` : undefined,
      key: head.split("\t")[1],
      count: maxRepeats + denials[head],
    };
  }
  const nudge = idx.length >= 2 && resultsSimilar(outs[idx[idx.length - 2]], outs[idx[idx.length - 1]]);
  const window = [...state.window, key];
  const nextOuts = [...outs];
  while (nextOuts.length < state.window.length) nextOuts.push(null);
  nextOuts.push(null);
  return { state: { ...state, window: window.slice(-WINDOW_CAP), outs: nextOuts.slice(-WINDOW_CAP) }, deny: false, ...(nudge ? { note: gc.note_message as string, id: "growing-command" } : {}) };
}

/**
 * One step of the loop guard. A pattern in monitor mode (or retired, or excepted) is neutralised here, in one place:
 * the step still counts, but nothing is denied, stopped or noted; a monitored one says what it would have done.
 */
export function stepLoopGuard(state: LoopState, tool: string, input?: string | Record<string, unknown>, fingerprint?: string | null, now = Date.now(), cwd?: string, echo: EchoConfig = DEFAULT_ECHO, ledger = false, source: "hook" | "proxy" = "hook"): LoopStep {
  const r = stepLoopGuardCore(state, tool, input, fingerprint, now, cwd, echo, source);
  if (!ledger) return r;
  const obj = typeof input === "object" ? input : undefined;
  const file = tool === "Write" ? String(obj?.file_path ?? "") || null : null;
  return { ...r, state: ledgerStep({ ...r.state, fail: state.fail }, tool, file ? callKey(tool, input) : null, file, source === "proxy" ? null : missingProbe(tool, obj, cwd ?? process.cwd())) };
}

function stepLoopGuardCore(state: LoopState, tool: string, input?: string | Record<string, unknown>, fingerprint?: string | null, now = Date.now(), cwd?: string, echo: EchoConfig = DEFAULT_ECHO, source: "hook" | "proxy" = "hook"): LoopStep {
  let r = stepLoopGuardRaw(state, tool, input, fingerprint, now, cwd, echo);
  const command = tool === "Bash" ? bashCommand(input) : undefined;
  const bashWrites = command !== undefined ? bashWriteTargets(command) : null;
  // a result that brings new information (Read, Bash, Grep) resets the rewrite counts of every file; a bare Bash write does not, it is a write
  if (READ_TOOLS.has(tool) && !bashWrites && r.state.rewrites) r = { ...r, state: { ...r.state, rewrites: undefined } };
  if (bashWrites && command !== undefined) r = countBashRewrites(r, bashWrites, command);
  return applyLifecycle(trackStreaks(r, state, tool, input, bashWrites, cwd, source));
}

/** distinct-rewrites for files written through Bash (heredoc, redirect, tee): the command text is the version. */
function countBashRewrites(r: LoopStep, files: string[], command: string): LoopStep {
  const hash = createHash("sha1").update(command).digest("hex").slice(0, 12);
  const rewrites = { ...(r.state.rewrites ?? {}) };
  let note: string | undefined;
  let key = "";
  for (const f of files) {
    const n = countRewrite(rewrites, f, hash, !!note || !!r.note || r.deny);
    if (n) {
      note = n;
      key = f;
    }
  }
  for (const k of Object.keys(rewrites).slice(0, -LAST_CAP * 8)) delete rewrites[k];
  return { ...r, state: { ...r.state, rewrites }, ...(note ? { note, id: "distinct-rewrites", key } : {}) };
}

/** A Read/Glob/Grep path argument that points at nothing; null when the call names no path or it exists. */
function missingProbe(tool: string, input: Record<string, unknown> | undefined, cwd: string): string | null {
  const p = probePath(tool, input);
  return p && !existsSync(resolve(cwd, p)) ? p : null;
}

/** The path a Read/Glob/Grep call points at; null for other tools or a call without a path. */
export function probePath(tool: string, input: unknown): string | null {
  const o = (input && typeof input === "object" ? input : undefined) as Record<string, unknown> | undefined;
  const p = tool === "Read" ? o?.file_path : tool === "Glob" || tool === "Grep" ? o?.path : undefined;
  return typeof p === "string" && p ? p : null;
}

/**
 * The two streak detectors, which count across edits and so live outside the window:
 * runaway-new-files (Writes of paths that do not exist yet since the last Read/Bash/Grep/Glob) and
 * missing-path-streak (Read/Glob/Grep of missing paths with no other tool call in between).
 */
function trackStreaks(r: LoopStep, prev: LoopState, tool: string, input: string | Record<string, unknown> | undefined, bashWrites: string[] | null, cwd = process.cwd(), source: "hook" | "proxy" = "hook"): LoopStep {
  const obj = typeof input === "object" ? input : undefined;
  let nf = prev.streaks?.newFiles ?? { n: 0 };
  let missing = prev.streaks?.missing ?? 0;
  // a proxy event has no disk to ask (the client may be another machine): no new-file signal, and the missing count
  // comes from the tool results (proxy-loop.ts), so a probe call keeps the count its predecessors' results built
  const proxy = source === "proxy";
  const isNew = (f: unknown): boolean => !proxy && typeof f === "string" && !!f && !existsSync(resolve(cwd, f));
  if (tool === "Write") {
    if (isNew(obj?.file_path)) nf = { ...nf, n: nf.n + 1 };
  } else if (bashWrites) nf = { ...nf, n: nf.n + bashWrites.filter(isNew).length };
  else if (READ_TOOLS.has(tool) || tool === "Glob") nf = { n: 0 };
  const probe = proxy ? probePath(tool, obj) : missingProbe(tool, obj, cwd);
  if (!proxy) missing = probe ? missing + 1 : 0;
  else if (!probe) missing = 0;

  let out = r;
  const rn = live("runaway-new-files");
  const mp = live("missing-path-streak");
  if (!out.deny && missing >= (mp.params.streak as number)) {
    out = { ...out, deny: true, stop: true, id: "missing-path-streak", key: probe ?? "", count: missing, reason: fillMessage(mp.message, { streak: missing }), note: undefined };
  } else if (!out.deny && tool === "Write" && nf.n >= (rn.params.stop_at as number)) {
    out = { ...out, deny: true, stop: true, id: "runaway-new-files", key: String(obj?.file_path ?? ""), count: nf.n, reason: fillMessage(rn.params.stop_message as string, { n: nf.n }), note: undefined };
  } else if (!out.deny && !out.note && !nf.fired && nf.n >= (rn.params.note_at as number)) {
    nf = { ...nf, fired: true };
    out = { ...out, note: fillMessage(rn.message, { n: nf.n }), id: "runaway-new-files", key: String(obj?.file_path ?? "") };
  }
  const next = nf.n || missing ? { ...(nf.n ? { newFiles: nf } : {}), ...(missing ? { missing } : {}) } : undefined;
  if (JSON.stringify(next) === JSON.stringify(prev.streaks)) return out;
  return { ...out, state: { ...out.state, streaks: next } };
}

function applyLifecycle(r: LoopStep): LoopStep {
  if (!r.id || !(r.deny || r.note)) return r;
  const ap = activeAntipattern(r.id);
  const disp = dispositionOf(ap, r.key ?? "");
  if (disp === "enforce") return r;
  const { reason: _reason, note: _note, evasion: _evasion, ...rest } = r;
  return { ...rest, deny: false, stop: false, ...(disp === "monitor" ? { monitored: { action: r.stop ? "stop" : r.deny ? "deny" : "note" } } : {}) } as LoopStep;
}

/**
 * PostToolUseFailure: counts a failed call. A call that fails input validation may never reach PreToolUse,
 * so when Pre did not record this call (no pending window entry) the call is stepped here first.
 * `deny` then means the 4th identical failure: hand `reason` back as context and stop the session if `stop`.
 */
export function recordLoopFailure(state: LoopState, tool: string, input: string | Record<string, unknown> | undefined, error: unknown, now = Date.now(), cwd?: string, ledger = false, source: "hook" | "proxy" = "hook"): LoopStep {
  const key = callKey(tool, input);
  if (key === null || EDIT_TOOLS.has(tool)) return { state, deny: false };
  const last = state.window.length - 1;
  const seenByPre = last >= 0 && state.window[last] === key && (state.outs?.[last] ?? null) === null;
  let step: LoopStep = { state, deny: false };
  if (!seenByPre) {
    step = stepLoopGuard(state, tool, input, null, now, cwd, undefined, ledger, source);
    if (step.deny) return { ...step, reason: step.reason ?? loopDenyReason(tool, step.count) };
  }
  return { ...step, state: recordLoopResult(step.state, tool, input, `error: ${resultSig(error)}`, now, ledger) };
}
