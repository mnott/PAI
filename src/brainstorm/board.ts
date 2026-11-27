/**
 * board.ts — the brainstorm board: ~/.pai/brainstorm/<id>/board.md (the posts, append-only) plus
 * index.json (goal, deadline, post count, closed). The only writer is `post`, which takes a
 * directory lock, numbers the post, appends it to board.md and rewrites the index. `waitPosts`
 * is the blocking primitive the round-table loop is built on: it returns when the board has posts
 * after `since`, the deadline passes, or CLOSED is posted. No agent ever sleep-polls.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BoardIndex {
  id: string;
  goal: string;
  createdAt: string;
  /** Epoch ms after which a wait returns "deadline"; null = none. */
  deadlineMs: number | null;
  count: number;
  closed: boolean;
}

export interface Post {
  n: number;
  role: string;
  at: string;
  text: string;
}

export type WaitState = "new" | "deadline" | "closed";

export const BOARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function brainstormRoot(): string {
  return process.env.PAI_BRAINSTORM_DIR || join(homedir(), ".pai", "brainstorm");
}

export function boardDir(id: string, root = brainstormRoot()): string {
  if (!BOARD_ID_RE.test(id)) throw new Error(`bad brainstorm id "${id}"`);
  return join(root, id);
}

const HEAD_RE = /^<!--post n=(\d+) role=(\S+) at=(\S+)-->$/;

function readIndex(dir: string): BoardIndex | null {
  try {
    return JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as BoardIndex;
  } catch {
    return null;
  }
}

function writeIndex(dir: string, idx: BoardIndex): void {
  const tmp = join(dir, `index.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(idx));
  renameSync(tmp, join(dir, "index.json"));
}

export function createBoard(id: string, goal: string, deadlineMs: number | null, root = brainstormRoot()): BoardIndex {
  const dir = boardDir(id, root);
  mkdirSync(dir, { recursive: true });
  const idx: BoardIndex = { id, goal, createdAt: new Date().toISOString(), deadlineMs, count: 0, closed: false };
  writeFileSync(join(dir, "board.md"), `# Brainstorm ${id}\n\nGoal: ${goal}\n\n`);
  writeIndex(dir, idx);
  return idx;
}

export function loadIndex(id: string, root = brainstormRoot()): BoardIndex | null {
  return readIndex(boardDir(id, root));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Directory lock (mkdir is atomic); a lock older than 10 s belongs to a dead poster and is broken. */
async function withLock<T>(dir: string, fn: () => T): Promise<T> {
  const lock = join(dir, "board.lock");
  const until = Date.now() + 15000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > until) throw new Error("board lock timeout");
      await sleepMs(5 + Math.floor(Math.random() * 15));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** True when this post closes the board: the moderator's text starts with CLOSED. */
export function isClosingPost(role: string, text: string): boolean {
  return role === "moderator" && /^\s*CLOSED\b/.test(text);
}

/** Append one post atomically; returns it with its sequence number. Refuses posts to a closed board. */
export async function post(id: string, role: string, text: string, root = brainstormRoot()): Promise<Post> {
  const dir = boardDir(id, root);
  if (!existsSync(join(dir, "index.json"))) throw new Error(`no brainstorm board "${id}"`);
  if (!/^[A-Za-z0-9._-]+$/.test(role)) throw new Error(`bad role "${role}" (letters, digits, . _ - only)`);
  const body = text.replace(/\r\n/g, "\n").replace(/^<!--post /gm, " <!--post ").trimEnd();
  if (!body) throw new Error("empty post");
  return withLock(dir, () => {
    const idx = readIndex(dir);
    if (!idx) throw new Error(`no brainstorm board "${id}"`);
    if (idx.closed) throw new Error(`board ${id} is closed`);
    const p: Post = { n: idx.count + 1, role, at: new Date().toISOString(), text: body };
    appendFileSync(join(dir, "board.md"), `<!--post n=${p.n} role=${p.role} at=${p.at}-->\n${body}\n\n`);
    idx.count = p.n;
    if (isClosingPost(role, body)) idx.closed = true;
    writeIndex(dir, idx);
    return p;
  });
}

export function readPosts(id: string, since = 0, root = brainstormRoot()): Post[] {
  let raw: string;
  try {
    raw = readFileSync(join(boardDir(id, root), "board.md"), "utf8");
  } catch {
    return [];
  }
  const out: Post[] = [];
  let cur: Post | null = null;
  for (const line of raw.split("\n")) {
    const m = HEAD_RE.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { n: Number(m[1]), role: m[2], at: m[3], text: "" };
    } else if (cur) cur.text += (cur.text ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  for (const p of out) p.text = p.text.replace(/\s+$/, "");
  return out.filter((p) => p.n > since);
}

export function renderPost(p: Post): string {
  return `#${p.n} [${p.role}] ${p.at}\n${p.text}\n`;
}

export interface WaitResult {
  state: WaitState;
  posts: Post[];
  last: number;
}

/**
 * Block until the board has posts after `since`, the board is closed, or the deadline (the board's,
 * or now+maxSec, whichever is first) passes. New posts are returned together with state "closed"
 * when the board closed meanwhile, so the closing synthesis is never lost.
 */
export async function waitPosts(id: string, since: number, maxSec?: number, root = brainstormRoot(), pollMs = 250): Promise<WaitResult> {
  const dir = boardDir(id, root);
  const start = Date.now();
  for (;;) {
    const idx = readIndex(dir);
    if (!idx) throw new Error(`no brainstorm board "${id}"`);
    if (idx.count > since || idx.closed) {
      const posts = readPosts(id, since, root);
      const last = posts.length ? posts[posts.length - 1].n : since;
      if (idx.closed) return { state: "closed", posts, last };
      if (posts.length) return { state: "new", posts, last };
    }
    const now = Date.now();
    if ((idx.deadlineMs !== null && now >= idx.deadlineMs) || (maxSec !== undefined && now - start >= maxSec * 1000)) {
      return { state: "deadline", posts: [], last: since };
    }
    await sleepMs(pollMs);
  }
}

export const EXIT_NEW = 0;
export const EXIT_DEADLINE = 3;
export const EXIT_CLOSED = 4;

export function exitCodeFor(s: WaitState): number {
  return s === "new" ? EXIT_NEW : s === "deadline" ? EXIT_DEADLINE : EXIT_CLOSED;
}
