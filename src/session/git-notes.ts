/** Link commits to the session/worker that wrote them via `git notes --ref=pai`. */

import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface SessionTouch { sessionId: string; workerId?: string; files: string[] }

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const HOOK_MARKER = "# PAI-GIT-NOTES: managed by `pai git setup`";
const NOTES_REF = "refs/notes/pai";
const LOOKBACK_MS = 6 * 3600 * 1000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const HOOK_BUDGET_MS = 500;

/** A refusal `pai git setup` reports to the user as-is. */
export class GitNotesError extends Error {}

/** Call `onLine` for each line of `file`, reading in chunks; stops early when it returns false. */
function eachLine(file: string, onLine: (line: string) => boolean): void {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let rest = "";
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      const parts = (rest + buf.toString("utf8", 0, n)).split("\n");
      rest = parts.pop() ?? "";
      for (const l of parts) if (!onLine(l)) return;
    }
    if (rest) onLine(rest);
  } finally {
    closeSync(fd);
  }
}

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

function jsonlFiles(dir: string, sinceMs: number, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    try {
      const st = statSync(p);
      if (st.isDirectory()) jsonlFiles(p, sinceMs, out);
      else if (/\.jsonl(\.1)?$/.test(n) && st.mtimeMs >= sinceMs) out.push(p);
    } catch { /* vanished */ }
  }
  return out;
}

/** Sessions whose Edit/Write-style tool events (after `sinceMs`) touched any of `paths`. */
export function sessionsTouching(paths: string[], sinceMs: number, captureDir: string, deadline = Infinity): SessionTouch[] {
  const wanted = new Map(paths.map((p) => [real(p), p]));
  const bySession = new Map<string, SessionTouch>();
  for (const file of jsonlFiles(captureDir, sinceMs)) {
    if (Date.now() > deadline) break;
    try { if (statSync(file).size > MAX_CAPTURE_BYTES) continue; } catch { continue; }
    try { eachLine(file, (line) => {
      if (Date.now() > deadline) return false;
      if (!line.includes("file_path") && !line.includes("notebook_path")) return true;
      let e: any;
      try { e = JSON.parse(line); } catch { return true; }
      const tool = e.tool ?? e.payload?.tool_name;
      if (!EDIT_TOOLS.has(tool)) return true;
      const ts = typeof e.timestamp === "number" ? e.timestamp : Date.parse(e.timestamp);
      if (Number.isFinite(ts) && ts < sinceMs) return true;
      const input = e.input ?? e.payload?.tool_input ?? {};
      const fp = input.file_path ?? input.notebook_path;
      const sessionId = e.session ?? e.session_id;
      if (typeof fp !== "string" || typeof sessionId !== "string") return true;
      const orig = wanted.get(real(fp));
      if (!orig) return true;
      const workerId = e.workerId ?? e.worker_id ?? e.env?.PAI_WORKER_ID ?? e.payload?.env?.PAI_WORKER_ID;
      const cur = bySession.get(sessionId) ?? { sessionId, files: [] };
      if (typeof workerId === "string" && !cur.workerId) cur.workerId = workerId;
      if (!cur.files.includes(orig)) cur.files.push(orig);
      bySession.set(sessionId, cur);
      return true;
    }); } catch { /* unreadable */ }
  }
  return [...bySession.values()];
}

/** Note body: one `pai-session` line per session, plus `pai-worker` where known. */
export function noteText(entries: SessionTouch[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`pai-session: ${e.sessionId}`);
    if (e.workerId) lines.push(`pai-worker: ${e.workerId}`);
  }
  return lines.join("\n");
}

/** Attach `text` to `commit` under refs/notes/pai; false on any error. */
export function writeNote(repo: string, commit: string, text: string): boolean {
  try {
    execFileSync("git", ["notes", "--ref=pai", "add", "-f", "-m", text, commit], { cwd: repo, timeout: 3000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const git = (repo: string, args: string[], timeout = 1000): string =>
  execFileSync("git", args, { cwd: repo, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const gitOk = (repo: string, args: string[]): boolean => {
  try { git(repo, args); return true; } catch { return false; }
};

/** The post-commit work: note the sessions that edited the files of HEAD. Never throws. */
export function postCommitHook(repo: string, captureDir: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  const deadline = now + HOOK_BUDGET_MS;
  try {
    if (/rebase/.test(env.GIT_REFLOG_ACTION ?? "")) return false;
    if (gitOk(repo, ["rev-parse", "-q", "--verify", "REBASE_HEAD"]) || gitOk(repo, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"])) return false;
    const top = git(repo, ["rev-parse", "--show-toplevel"]);
    const files = git(repo, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").filter(Boolean).map((f) => join(top, f));
    const text = noteText(sessionsTouching(files, now - LOOKBACK_MS, captureDir, deadline));
    if (Date.now() > deadline) return false;
    return text ? writeNote(repo, "HEAD", text) : false;
  } catch {
    return false;
  }
}

function hookPath(repo: string): string {
  const p = git(repo, ["rev-parse", "--git-path", "hooks/post-commit"]);
  return isAbsolute(p) ? p : resolve(repo, p);
}

/** Install the post-commit hook, chaining an existing foreign hook as post-commit.pre-pai. */
export function setupGitNotes(repo: string): { hook: string; chained: boolean } {
  const hook = hookPath(repo);
  const gitDirs = ["--git-dir", "--git-common-dir"].map((a) => real(resolve(repo, git(repo, ["rev-parse", a]))));
  const hookDir = real(dirname(hook));
  if (!gitDirs.some((d) => hookDir === d || hookDir.startsWith(d + sep))) {
    throw new GitNotesError(`core.hooksPath points outside .git (${hook}); refusing to write a hook there. Unset it or install the hook yourself`);
  }
  const old = `${hook}.pre-pai`;
  let chained = existsSync(old);
  if (existsSync(hook) && !readFileSync(hook, "utf8").includes(HOOK_MARKER)) {
    if (existsSync(old)) throw new GitNotesError(`${old} already exists; refusing to overwrite it. Move it away and re-run`);
    renameSync(hook, old);
    chained = true;
  }
  const script = `#!/bin/sh\n${HOOK_MARKER}\n${chained ? 'd=$(dirname "$0")\n[ -x "$d/post-commit.pre-pai" ] && "$d/post-commit.pre-pai" "$@"\n' : ""}( pai git hook post-commit >/dev/null 2>&1 & )\n`;
  writeFileSync(hook, script);
  chmodSync(hook, 0o755);
  git(repo, ["config", "notes.rewriteRef", NOTES_REF]);
  return { hook, chained };
}

/** Remove the PAI hook and restore the chained one; false when PAI had no hook here. */
export function removeGitNotes(repo: string): boolean {
  const hook = hookPath(repo);
  const old = `${hook}.pre-pai`;
  if (!existsSync(hook) || !readFileSync(hook, "utf8").includes(HOOK_MARKER)) return false;
  unlinkSync(hook);
  if (existsSync(old)) renameSync(old, hook);
  try { if (git(repo, ["config", "notes.rewriteRef"]) === NOTES_REF) git(repo, ["config", "--unset", "notes.rewriteRef"]); } catch { /* unset */ }
  return true;
}

/** The PAI note of `rev`, or undefined. */
export function showNote(repo: string, rev = "HEAD"): string | undefined {
  try { return git(repo, ["notes", "--ref=pai", "show", rev]) || undefined; } catch { return undefined; }
}
