/**
 * queue.ts — `pai queue`: items, per-project settings, the state file, spec
 * composition, size classification and review rendering. Pure and file-only;
 * workers, git and the clock live in queue-runner.ts / queue-deps.ts.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { breakStaleMutex } from "../builds/queue.js";
import { paiHomePath } from "../config/pai-home.js";

export type ItemState = "pending" | "running" | "ready" | "too-big" | "needs-decision" | "cloud" | "accepted" | "rejected";

export interface DiffInfo {
  files: number;
  lines: number;
  /** `git diff --stat` text of the worker branch. */
  stat: string;
}

export interface QueueItem {
  id: string;
  text: string;
  repo: string;
  files: string[];
  image?: string;
  created: string;
  state: ItemState;
  /** `again` rounds so far. */
  rounds: number;
  /** Operator notes from `again`, oldest first. */
  notes: string[];
  /** Diff of the attempt the latest note is about. */
  prevDiff?: string;
  worker?: string;
  diff?: DiffInfo;
  gate?: { ok: boolean; output: string };
  proof?: string;
  report?: string;
  why?: string;
}

export interface QueueSettings {
  provider?: string;
  gate?: string;
  proof?: string;
  install?: string;
  maxFiles: number;
  maxLines: number;
  maxParallel?: number;
  rules?: string;
}

export const DEFAULT_MAX_FILES = 6;
export const DEFAULT_MAX_LINES = 200;

export const QUEUE_YAML_SCHEMA = `# <project>/.pai/queue.yaml — all keys optional
provider: local        # default: the active local provider
gate: xcodebuild ...   # run in the worker's worktree before "ready", and on accept (default: none)
proof: ./shot.sh       # prints a path (e.g. a PNG) on its last stdout line, run in the worktree
install: ./install.sh  # run in the checkout after a successful accept
max_files: 6           # larger diffs become "too-big"
max_lines: 200         # added + removed lines
max_parallel: 2        # default: the provider's maxConcurrent
rules: Use tabs.       # extra text appended to every worker spec`;

export function parseSettings(text: string): QueueSettings {
  const raw = (text.trim() ? parseYaml(text) : {}) as Record<string, unknown> | null;
  const o = raw && typeof raw === "object" ? raw : {};
  const str = (k: string): string | undefined => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
  const num = (k: string): number | undefined => (typeof o[k] === "number" && Number.isFinite(o[k]) && (o[k] as number) > 0 ? Math.floor(o[k] as number) : undefined);
  return {
    provider: str("provider"),
    gate: str("gate"),
    proof: str("proof"),
    install: str("install"),
    maxFiles: num("max_files") ?? DEFAULT_MAX_FILES,
    maxLines: num("max_lines") ?? DEFAULT_MAX_LINES,
    maxParallel: num("max_parallel"),
    rules: str("rules"),
  };
}

export function loadSettings(repo: string): QueueSettings {
  const p = join(repo, ".pai", "queue.yaml");
  return parseSettings(existsSync(p) ? readFileSync(p, "utf8") : "");
}

/** Per-project state file under the PAI home, never in the repo. */
export function queueStatePath(repo: string): string {
  const abs = resolve(repo);
  const key = `${basename(abs).replace(/[^A-Za-z0-9._-]/g, "_")}-${createHash("sha1").update(abs).digest("hex").slice(0, 8)}`;
  return paiHomePath("queue", `${key}.json`);
}

interface StateFile {
  next: number;
  items: QueueItem[];
}

export class QueueStore {
  constructor(
    readonly path: string,
    private now: () => number = Date.now,
  ) {}

  /** A missing file is an empty queue; anything unreadable is refused so the next write cannot replace it. */
  private read(): StateFile {
    if (!existsSync(this.path)) return { next: 1, items: [] };
    let s: StateFile;
    try {
      s = JSON.parse(readFileSync(this.path, "utf8")) as StateFile;
      if (!s || !Array.isArray(s.items)) throw new Error("no items array");
    } catch (e) {
      throw new Error(`queue file ${this.path} is unreadable (${(e as Error).message}); fix or remove it by hand, it was left untouched`);
    }
    return { next: s.next ?? s.items.length + 1, items: s.items };
  }

  private write(s: StateFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", "utf8");
      renameSync(tmp, this.path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** The one mutation path: read, apply `fn`, write, all under a cross-process mkdir lock. */
  private mutate<T>(fn: (s: StateFile) => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const m = `${this.path}.mutex`;
    const t0 = Date.now();
    for (;;) {
      try {
        mkdirSync(m);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        breakStaleMutex(m, 10_000);
        if (Date.now() - t0 > 30_000) throw new Error(`queue file ${this.path} is locked by another process`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 15));
      }
    }
    try {
      const s = this.read();
      const r = fn(s);
      this.write(s);
      return r;
    } finally {
      try {
        rmdirSync(m);
      } catch {
        /* gone */
      }
    }
  }

  list(): QueueItem[] {
    return this.read().items;
  }

  get(id: string): QueueItem | undefined {
    return this.list().find((i) => i.id === id);
  }

  add(text: string, repo: string, opts: { files?: string[]; image?: string } = {}): QueueItem {
    return this.mutate((s) => {
      const item: QueueItem = {
        id: `q${s.next}`,
        text: text.trim(),
        repo,
        files: opts.files ?? [],
        ...(opts.image ? { image: opts.image } : {}),
        created: new Date(this.now()).toISOString(),
        state: "pending",
        rounds: 0,
        notes: [],
      };
      s.next++;
      s.items.push(item);
      return item;
    });
  }

  /** Apply `patch` to one item; throws on an unknown id. */
  update(id: string, patch: Partial<QueueItem>): QueueItem {
    return this.mutate((s) => {
      const i = s.items.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`no queue item ${id}`);
      s.items[i] = { ...s.items[i], ...patch };
      return s.items[i];
    });
  }
}

// ---------------------------------------------------------------------------
// transitions

const ALLOWED: Record<ItemState, ItemState[]> = {
  pending: ["running", "rejected"],
  running: ["ready", "too-big", "needs-decision", "pending"],
  ready: ["accepted", "rejected", "pending", "cloud"],
  "too-big": ["rejected", "pending", "cloud"],
  "needs-decision": ["rejected", "pending", "cloud"],
  cloud: ["running", "rejected"],
  accepted: [],
  rejected: [],
};

export function canMove(from: ItemState, to: ItemState): boolean {
  return ALLOWED[from].includes(to);
}

export function move(store: QueueStore, id: string, to: ItemState, patch: Partial<QueueItem> = {}): QueueItem {
  const it = store.get(id);
  if (!it) throw new Error(`no queue item ${id}`);
  if (!canMove(it.state, to)) throw new Error(`${id} is ${it.state}; it cannot become ${to}`);
  return store.update(id, { ...patch, state: to });
}

export const MAX_AGAIN_ROUNDS = 2;

/** Re-queue an item with the operator's note; the second round goes to the cloud instead. */
export function again(store: QueueStore, id: string, note: string, prevDiff?: string): QueueItem {
  const it = store.get(id);
  if (!it) throw new Error(`no queue item ${id}`);
  const rounds = it.rounds + 1;
  const to: ItemState = rounds >= MAX_AGAIN_ROUNDS ? "cloud" : "pending";
  return move(store, id, to, { rounds, notes: [...it.notes, note.trim()], prevDiff: prevDiff ?? it.prevDiff, why: undefined });
}

// ---------------------------------------------------------------------------
// size

/** null when the diff fits the limits, else why it is too big. */
export function classifySize(d: Pick<DiffInfo, "files" | "lines">, s: Pick<QueueSettings, "maxFiles" | "maxLines">): string | null {
  const over: string[] = [];
  if (d.files > s.maxFiles) over.push(`${d.files} files (limit ${s.maxFiles})`);
  if (d.lines > s.maxLines) over.push(`${d.lines} lines (limit ${s.maxLines})`);
  return over.length ? `too big: ${over.join(", ")}` : null;
}

/** Sum a `git diff --numstat` output; binary files count as one file, no lines. */
export function parseNumstat(text: string): Pick<DiffInfo, "files" | "lines"> {
  let files = 0;
  let lines = 0;
  for (const l of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(l);
    if (!m) continue;
    files++;
    lines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
  }
  return { files, lines };
}

// ---------------------------------------------------------------------------
// spec

export function queueFooter(it: QueueItem, s: QueueSettings): string {
  return [
    "---",
    "Rules for this task:",
    "- Work only with RELATIVE paths inside the current working directory. It is your own git worktree; never use an absolute path to the repository, or you edit the main checkout instead.",
    `- Keep the change small: at most ${s.maxFiles} files and ${s.maxLines} changed lines. If the task needs more, stop, change nothing and report why.`,
    `- ${s.gate ? `Do not run the full test suite; the gate (${s.gate}) is run for you.` : "Do not run a full test suite."}`,
    `- Git add the files you changed, then commit on the current branch before you report, with the message "queue ${it.id}: ${it.text.slice(0, 60)}". An empty commit is not a commit; uncommitted work is lost.`,
    "- Report with an R message.",
    ...(s.rules ? ["", "Project rules:", s.rules] : []),
  ].join("\n");
}

/** The worker task: the operator's sentence, files, image, earlier attempt and notes, then the fixed footer. */
export function composeQueueSpec(it: QueueItem, s: QueueSettings, failure?: string): string {
  const lines = [it.text];
  if (it.files.length) lines.push("", `Files this probably touches: ${it.files.join(", ")}`);
  if (it.image) lines.push("", `Reference image (look at it): ${it.image}`);
  if (s.proof) lines.push("", `Proof: after the change \`${s.proof}\` is run and its output shown to the operator.`);
  if (it.notes.length) {
    if (it.prevDiff) lines.push("", "A previous attempt made this change, and the operator says it is still wrong:", "```diff", it.prevDiff.trim(), "```");
    lines.push("", "Operator notes, oldest first:", ...it.notes.map((n, i) => `${i + 1}. ${n}`), "Address the latest note.");
  }
  if (failure) lines.push("", "The previous attempt failed. Its failure output (tail):", "```", failure.trim(), "```", "Fix the cause and try again.");
  lines.push("", queueFooter(it, s));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// rendering

const oneLine = (t: string, n = 60) => (t.replace(/\s+/g, " ").length > n ? t.replace(/\s+/g, " ").slice(0, n - 1) + "…" : t.replace(/\s+/g, " "));
const statShort = (d?: DiffInfo) => (d ? `${d.files}f/${d.lines}l` : "-");

export function renderReview(items: QueueItem[]): string {
  const ready = items.filter((i) => i.state === "ready");
  if (!ready.length) return "nothing ready";
  return ready
    .map((i) => `${i.id}  ${oneLine(i.text)}  ${statShort(i.diff)}  gate ${i.gate ? (i.gate.ok ? "ok" : "FAILED") : "-"}  proof ${i.proof ?? "-"}`)
    .join("\n");
}

export function renderList(items: QueueItem[]): string {
  if (!items.length) return "queue is empty";
  return items.map((i) => `${i.id}  ${i.state.padEnd(14)} ${oneLine(i.text)}${i.why ? `  (${oneLine(i.why, 50)})` : ""}`).join("\n");
}
