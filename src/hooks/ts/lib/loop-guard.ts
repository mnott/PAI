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
 * run of the key, so edits made through Bash count as progress too.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

export const LOOP_MAX_REPEATS = 4;
/** Denials of one cluster after which the session is stopped (the 7th attempt). */
export const LOOP_STOP_DENIALS = 3;
const SIMILARITY = 0.9;
const READ_OVERLAP = 0.8;
const RESULT_CHARS = 2000;
const WINDOW_CAP = 64;

const SELF = "If your part is done, commit and write your R report. If you are stuck, report the blocker in R x= (or use pai worker help if available).";
export const LOOP_DENY_REASON = `loop guard: you ran this command ${LOOP_MAX_REPEATS} times with the same result and nothing changed. Stop repeating it. ${SELF}`;

export function loopDenyReason(tool = "Bash", count = LOOP_MAX_REPEATS): string {
  return tool === "Bash"
    ? LOOP_DENY_REASON
    : `loop guard: you called ${tool} with similar input ${count} times with the same result and nothing changed. Stop repeating it; the earlier result is still valid. ${SELF}`;
}

export interface LoopState {
  /** Call keys (`Tool\tnormalised input`) since the last edit, oldest first. */
  window: string[];
  /** Normalised result text per window entry; null while unknown. */
  outs?: Array<string | null>;
  /** Denials per cluster head since the last edit. */
  denials?: Record<string, number>;
  /** Runner invocations per action key since the last edit (see actionKey). */
  runs?: Record<string, number>;
  /** Worktree fingerprint at the last counted run per action key; a different one is progress. */
  prints?: Record<string, string>;
  /** Window key -> ms timestamp of the first "still running" result of a polling call (see isWaitResult). */
  waits?: Record<string, number>;
}

/** Total polling time per command key after which a "still running" helper is treated as an ordinary repeat again. */
export const WAIT_CAP_MS = 45 * 60_000;
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

/** Runs of one action key without an edit at which the call is denied / the session stopped. */
export const RUN_DENY_AT = 3;
export const RUN_STOP_AT = 5;

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

/**
 * Cheap fingerprint of the worktree state: `git status` (tracked changes and untracked files) plus size and mtime of
 * each listed path, so re-editing an already modified file changes it. Null outside a git worktree or on error.
 */
export function worktreeFingerprint(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const h = createHash("sha1").update(out);
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      if (e[0] === "R" || e[0] === "C") i++; // rename: next field is the origin path
      try {
        const st = statSync(join(root, e.slice(3)));
        h.update(`${e.slice(3)}\t${st.size}\t${st.mtimeMs}\n`);
      } catch {
        // deleted path: the status line already says so
      }
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

/** The command itself edits files before it runs the runner (the fingerprint is taken before the command runs). */
function inlineEdit(command: string): boolean {
  return /\b(?:sed|perl)\s+(?:-\w+\s+)*-i|\bgit apply\b|\bpatch\s+-?\w*\s*-?p\d|\btee\s+(?!\/tmp)\S|(?:^|[;&|]\s*)cat\s*>>?\s*(?!\/tmp)[\w.]/.test(command.split(/&&|;|\|/).slice(0, -1).join(";") || "");
}

export function emptyLoopState(): LoopState {
  return { window: [] };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TMP_PATH = /(?:\/private)?\/tmp\/[^\s'";|&<>)]*|\$\{?TMPDIR\}?(?:\/[^\s'";|&<>)]*)?/g;
const WAIT_VERB = /\bpai worker (?:wait|wait-on|wait-url|wait-file)\b/;

function exempt(command: string): boolean {
  if (WAIT_VERB.test(command)) return true;
  const m = /\bsleep (\d+(?:\.\d+)?)\b/.exec(command);
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

/** Window key of a call, or null when it is not trackable or is exempt. Display text is the part after the tab. */
export function callKey(tool: string, input: string | Record<string, unknown> | undefined): string | null {
  if (tool === "Bash") {
    const c = typeof input === "string" ? input : (input as { command?: unknown } | undefined)?.command;
    return typeof c === "string" && c.trim() && !exempt(c) ? `Bash\t${loopKey(c)}` : null;
  }
  if (!tool || !input || typeof input !== "object") return null;
  if (tool === "Read") {
    const { start, end } = readRange(input);
    return `Read\tRead@${String(input.file_path ?? "")}#${start}-${Number.isFinite(end) ? end : "inf"}`;
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

/** PostToolUse: attaches the call's result to its window entry. An edit clears the state. */
export function recordLoopResult(state: LoopState, tool: string, input: string | Record<string, unknown> | undefined, response: unknown, now = Date.now()): LoopState {
  if (EDIT_TOOLS.has(tool)) return emptyLoopState();
  const key = callKey(tool, input);
  if (key !== null && tool === "Bash") {
    const waits = { ...(state.waits ?? {}) };
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
  return { ...state, outs };
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
}

/** Next state and whether this tool call is a loop repeat to deny. `input` is the Bash command or the tool input object. */
export function stepLoopGuard(state: LoopState, tool: string, input?: string | Record<string, unknown>, fingerprint?: string | null, now = Date.now()): LoopStep {
  if (EDIT_TOOLS.has(tool)) return { state: emptyLoopState(), deny: false };
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
    const cmd = typeof input === "string" ? input : (input as { command?: unknown } | undefined)?.command;
    const ak = typeof cmd === "string" ? actionKey(cmd) : null;
    if (ak !== null) {
      // the worktree changed since the previous run of this key (Bash edit, git apply, codegen): progress
      const changed = inlineEdit(cmd as string) || !!fingerprint && state.prints?.[ak] !== undefined && state.prints[ak] !== fingerprint;
      const n = (changed ? 0 : (state.runs?.[ak] ?? 0)) + 1;
      state = { ...state, runs: { ...(state.runs ?? {}), [ak]: n }, ...(fingerprint ? { prints: { ...(state.prints ?? {}), [ak]: fingerprint } } : {}) };
      if (n >= RUN_DENY_AT)
        return {
          state,
          deny: true,
          stop: n >= RUN_STOP_AT,
          key: ak,
          count: n,
          reason: `loop guard: you ran ${ak} ${RUN_DENY_AT} times without changing anything in the worktree; the result will not change. Read the failure, change code or the test, or report the blocker. ${SELF}`,
        };
    }
  }
  const key = callKey(tool, input);
  if (key === null) return { state, deny: false };
  const idx = clusterOf(state.window, key);
  const lastN = idx.slice(-LOOP_MAX_REPEATS);
  const outs = state.outs ?? [];
  const stalled = lastN.length >= LOOP_MAX_REPEATS && lastN.every((i, n) => n === 0 || resultsSimilar(outs[lastN[n - 1]], outs[i]));
  if (stalled) {
    const head = state.window[idx[0]];
    const denials = { ...(state.denials ?? {}) };
    denials[head] = (denials[head] ?? 0) + 1;
    return {
      state: { ...state, denials },
      deny: true,
      stop: denials[head] >= LOOP_STOP_DENIALS,
      key: head.split("\t")[1],
      count: LOOP_MAX_REPEATS + denials[head],
    };
  }
  const window = [...state.window, key];
  const nextOuts = [...outs];
  while (nextOuts.length < state.window.length) nextOuts.push(null);
  nextOuts.push(null);
  return { state: { ...state, window: window.slice(-WINDOW_CAP), outs: nextOuts.slice(-WINDOW_CAP) }, deny: false };
}
