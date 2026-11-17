/**
 * clean.ts — `pai clean`: a plonge-style (dry run first, refuse and say why) front end
 * for what PAI itself leaves on disk. It scans four categories, reports them, and on
 * --apply calls the existing paths: gcWorktrees for finished worktrees (salvage and
 * refs/pai-archive stay as they are); a move into logDir/archive/YYYY-MM for the
 * top-level files of long-finished workers; rm for supervision markers and for build
 * dirs a finished worker recorded in the ledger (WORKER-BUILD-DIR).
 *
 * Never touched: ledger.log, anything a live worker owns or references, symlinks,
 * paths outside their expected root, git repos with uncommitted or unpushed work.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { appendLedger, parseLedger } from "./ledger.js";
import { ledgerPath, statusPath } from "./paths.js";
import { pidsWithCwdInside } from "./reap.js";
import { isLive, isTerminal, loadStatuses, type WorkerStatus } from "./status.js";
import { supervisionDirPath } from "./supervision.js";
import { busyPid, dirBytes, gcWorktrees, ownedTree, worktreesDir } from "./worktree.js";

export type CleanCategory = "worktree" | "worker-files" | "supervision" | "build-dir";

export interface CleanOptions {
  /** Quiet period in hours for worktrees and build dirs (default 24). */
  olderThanHours?: number;
  /** Ignore items smaller than this many bytes. */
  minBytes?: number;
  /** Worker files and supervision markers wait this long (default 14 days). */
  archiveAfterDays?: number;
  now?: number;
}

export interface CleanItem {
  category: CleanCategory;
  /** Primary path (a directory, or the first file of a worker's file set). */
  path: string;
  /** Every path acted on. */
  paths: string[];
  bytes: number;
  /** Hours since last activity. */
  ageHours: number;
  owner: string;
  rule: string;
  action: "archive-ref" | "move-to-archive" | "delete";
  note?: string;
}

export interface CleanRefusal {
  category: CleanCategory;
  path: string;
  owner: string;
  reason: string;
}

export interface CleanScan {
  items: CleanItem[];
  refused: CleanRefusal[];
}

const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;

export const WORKER_FILE_RE = /^(.+?)\.(jsonl|status|prompt|sock|settings\.json|inbox\.jsonl|mcp\.json|kill|reroute\.prompt|loop-stop)$/;
const WORKER_SUBDIRS = ["waits", "loop-guard"];

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const inside = (child: string, root: string): boolean => child !== root && child.startsWith(root.endsWith(sep) ? root : root + sep);

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** Git repos (a `.git` entry, depth <= 3) under `dir` with uncommitted or unpushed work; first problem found. */
export function gitRisk(dir: string, depth = 3): string | null {
  const walk = (d: string, n: number): string | null => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return null;
    }
    if (names.includes(".git")) {
      try {
        if (git(d, ["status", "--porcelain"])) return `git repo ${d} has uncommitted changes`;
        if (Number(git(d, ["rev-list", "--count", "HEAD", "--not", "--remotes"])) > 0) return `git repo ${d} has unpushed commits`;
      } catch {
        return `git repo ${d} unreadable`;
      }
      return null;
    }
    if (n <= 0) return null;
    for (const name of names) {
      const p = join(d, name);
      const st = lstatOrNull(p);
      if (st?.isDirectory()) {
        const r = walk(p, n - 1);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(dir, depth);
}

/** Build dirs a worker declared: `-derivedDataPath X` and DERIVED_DATA_PATH, only under a temp root. */
export function buildDirsOf(command: readonly string[], env: NodeJS.ProcessEnv = {}): string[] {
  const out = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p && !/\s/.test(p) && isTmpPath(p)) out.add(p.replace(/\/+$/, ""));
  };
  command.forEach((a, i) => {
    if (a === "-derivedDataPath") add(command[i + 1]);
  });
  add(env.DERIVED_DATA_PATH);
  add(env.PAI_DERIVED_DATA_PATH);
  return [...out];
}

function tmpRoots(): string[] {
  return [...new Set(["/tmp", "/private/tmp", tmpdir(), realOr(tmpdir()), realOr("/tmp")])];
}

function isTmpPath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  return tmpRoots().some((r) => inside(resolve(p), r));
}

/** Record a worker's build dirs in the ledger so `pai clean` knows they are PAI's. */
export function recordBuildDirs(logDir: string, workerId: string | undefined, command: readonly string[], env: NodeJS.ProcessEnv = {}): void {
  if (!workerId) return;
  for (const p of buildDirsOf(command, env)) appendLedger(ledgerPath(logDir), "WORKER-BUILD-DIR", { id: workerId, path: p });
}

function buildDirsFromLedger(logDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let text = "";
  try {
    text = readFileSync(ledgerPath(logDir), "utf8");
  } catch {
    return out;
  }
  // only the lines of interest are parsed: the ledger is large
  const lines = text.split("\n").filter((l) => l.includes(" WORKER-BUILD-DIR "));
  for (const l of parseLedger(lines.join("\n"))) {
    const id = l.fields.id;
    const path = l.fields.path;
    if (!id || !path) continue;
    const cur = out.get(id) ?? [];
    if (!cur.includes(path)) cur.push(path);
    out.set(id, cur);
  }
  return out;
}

function monthOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function sizeOf(paths: string[]): number {
  let n = 0;
  for (const p of paths) {
    const st = lstatOrNull(p);
    if (!st) continue;
    n += st.isDirectory() ? dirBytes(p) : st.size;
  }
  return n;
}

function statusMtime(logDir: string, id: string): number | null {
  try {
    return Math.floor(statSync(statusPath(logDir, id)).mtimeMs);
  } catch {
    return null;
  }
}

/** Text of every live worker's status: a finished id any of them still names (resume, parent) is not clean's. */
function liveReferences(statuses: WorkerStatus[]): string {
  return statuses.filter((s) => isLive(s)).map((s) => JSON.stringify(s)).join("\n");
}

export function scanClean(logDir: string, o: CleanOptions = {}): CleanScan {
  const now = o.now ?? Date.now();
  const hours = o.olderThanHours ?? 24;
  if (!Number.isFinite(hours) || hours < 0) throw new Error(`bad older-than "${hours}"`);
  const minBytes = o.minBytes ?? 0;
  const longMs = Math.max(hours * HOUR, (o.archiveAfterDays ?? 14) * DAY_MS);
  const items: CleanItem[] = [];
  const refused: CleanRefusal[] = [];
  const statuses = loadStatuses(logDir);
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const liveRefs = liveReferences(statuses);
  const age = (ms: number): number => Math.max(0, Math.round(((now - ms) / HOUR) * 10) / 10);
  const refuse = (category: CleanCategory, path: string, owner: string, reason: string): void => void refused.push({ category, path, owner, reason });
  const keep = (it: CleanItem): void => {
    if (it.bytes >= minBytes) items.push(it);
  };

  // 1. finished worktrees: the existing gc decides, clean adds the guards around it
  const root = worktreesDir(logDir);
  const rootReal = realOr(root);
  for (const e of gcWorktrees(logDir, hours, true, now)) {
    if (e.branch) continue;
    const st = byId.get(e.id);
    const tree = st ? ownedTree(st) : null;
    const dir = tree?.dir ?? join(root, e.id);
    if (!existsSync(dir) && !lstatOrNull(dir)) continue;
    const owner = e.id;
    if (e.skipped) {
      refuse("worktree", dir, owner, e.skipped);
      continue;
    }
    if (!e.archive) continue;
    const l = lstatOrNull(dir);
    if (l?.isSymbolicLink()) {
      refuse("worktree", dir, owner, "symlink");
      continue;
    }
    if (!inside(realOr(dir), rootReal)) {
      refuse("worktree", dir, owner, `outside ${root}`);
      continue;
    }
    if ([...statuses].some((s) => isLive(s) && (s.id === e.id || (s.worktreeDir && resolve(s.worktreeDir) === resolve(dir))))) {
      refuse("worktree", dir, owner, "live worker owns it");
      continue;
    }
    const busy = busyPid(dir);
    if (busy) {
      refuse("worktree", dir, owner, `pid ${busy} has its cwd inside`);
      continue;
    }
    const mt = statusMtime(logDir, e.id) ?? statSync(dir).mtimeMs;
    keep({
      category: "worktree",
      path: dir,
      paths: [dir],
      bytes: dirBytes(dir),
      ageHours: age(mt),
      owner,
      rule: `finished worker, quiet > ${hours} h (pai worker gc)`,
      action: "archive-ref",
      note: `commits and notes kept under ${e.archive}`,
    });
  }

  // 2. top-level files of workers finished > 14 days: moved into archive/YYYY-MM
  const files = new Map<string, string[]>();
  if (existsSync(logDir)) {
    for (const name of readdirSync(logDir)) {
      const m = WORKER_FILE_RE.exec(name);
      if (!m) continue;
      const cur = files.get(m[1]!) ?? [];
      cur.push(join(logDir, name));
      files.set(m[1]!, cur);
    }
    for (const sub of WORKER_SUBDIRS) {
      const d = join(logDir, sub);
      if (!existsSync(d) || !lstatOrNull(d)?.isDirectory()) continue;
      for (const name of readdirSync(d)) {
        const id = name.replace(/\.[^.]+$/, "");
        const cur = files.get(id);
        if (cur) cur.push(join(d, name));
      }
    }
  }
  for (const [id, paths] of files) {
    const st = byId.get(id);
    if (!st) continue; // no status: not provably a finished worker, left alone
    const owner = id;
    const mt = statusMtime(logDir, id);
    if (mt === null || now - mt < longMs) continue;
    if (isLive(st) || !isTerminal(st.state)) {
      refuse("worker-files", paths[0]!, owner, "worker is live");
      continue;
    }
    const wt = st.worktreeDir && existsSync(st.worktreeDir) ? st.worktreeDir : null;
    if (wt) {
      refuse("worker-files", paths[0]!, owner, `worktree still on disk (${wt}); pai worker gc first`);
      continue;
    }
    if (liveRefs.includes(id)) {
      refuse("worker-files", paths[0]!, owner, "a live worker references it");
      continue;
    }
    const bad = paths.find((p) => {
      const l = lstatOrNull(p);
      return !l || l.isSymbolicLink() || !(l.isFile() || l.isSocket());
    });
    if (bad) {
      refuse("worker-files", bad, owner, "not a regular file (symlink or missing)");
      continue;
    }
    keep({
      category: "worker-files",
      path: paths[0]!,
      paths,
      bytes: sizeOf(paths),
      ageHours: age(mt),
      owner,
      rule: `worker finished > ${Math.round(longMs / DAY_MS)} d ago`,
      action: "move-to-archive",
      note: `archive/${monthOf(mt)} (${paths.length} file${paths.length === 1 ? "" : "s"})`,
    });
  }

  // 3. supervision markers of sessions no live worker names, quiet > 14 days
  const sup = supervisionDirPath(logDir);
  if (existsSync(sup)) {
    for (const name of readdirSync(sup)) {
      const m = /^(.+)\.(events|pushed)$/.exec(name);
      if (!m) continue;
      const p = join(sup, name);
      const l = lstatOrNull(p);
      if (!l) continue;
      if (l.isSymbolicLink() || !l.isFile()) {
        refuse("supervision", p, m[1]!, "not a regular file");
        continue;
      }
      if (now - l.mtimeMs < longMs) continue;
      if (liveRefs.includes(m[1]!)) {
        refuse("supervision", p, m[1]!, "a live worker names this session");
        continue;
      }
      keep({ category: "supervision", path: p, paths: [p], bytes: l.size, ageHours: age(l.mtimeMs), owner: m[1]!, rule: `session quiet > ${Math.round(longMs / DAY_MS)} d`, action: "delete" });
    }
  }

  // 4. build dirs outside the tree a finished worker recorded
  for (const [id, dirs] of buildDirsFromLedger(logDir)) {
    const st = byId.get(id);
    for (const dir of dirs) {
      if (!lstatOrNull(dir)) continue;
      if (!st) {
        refuse("build-dir", dir, id, "owner has no status");
        continue;
      }
      if (isLive(st) || !isTerminal(st.state)) {
        refuse("build-dir", dir, id, "worker is live");
        continue;
      }
      const reason = buildDirRefusal(dir, st, statuses, now, hours);
      if (reason) {
        refuse("build-dir", dir, id, reason);
        continue;
      }
      const mt = Math.max(statusMtime(logDir, id) ?? 0, statSync(dir).mtimeMs);
      keep({ category: "build-dir", path: dir, paths: [dir], bytes: dirBytes(dir), ageHours: age(mt), owner: id, rule: `recorded by finished worker, quiet > ${hours} h`, action: "delete" });
    }
  }
  return { items, refused };
}

/** Why a recorded build dir may not be removed now, or null. */
function buildDirRefusal(dir: string, owner: WorkerStatus, statuses: WorkerStatus[], now: number, hours: number): string | null {
  const l = lstatOrNull(dir);
  if (!l) return "gone";
  if (l.isSymbolicLink()) return "symlink";
  if (!l.isDirectory()) return "not a directory";
  const real = realOr(dir);
  if (!tmpRoots().some((r) => inside(real, realOr(r)))) return "outside the temp roots";
  // a dir another live worker also recorded or sits in is not this owner's alone
  if (statuses.some((s) => isLive(s) && s.cwd && (resolve(s.cwd) === real || inside(resolve(s.cwd), real)))) return "a live worker runs inside it";
  if (now - l.mtimeMs < hours * HOUR) return "not quiet (changed recently)";
  const pids = pidsWithCwdInside(dir);
  if (pids.length) return `pid ${pids[0]} has its cwd inside`;
  if (openFileHolder(real)) return "a process has files open inside";
  return gitRisk(dir);
}

function openFileHolder(dir: string): number {
  try {
    const raw = execFileSync("lsof", ["-t", "+D", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000, maxBuffer: 16 << 20 });
    const pid = Number(raw.split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch (e) {
    const raw = String((e as { stdout?: string }).stdout ?? "");
    const pid = Number(raw.split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  }
}

export interface CleanResult {
  done: CleanItem[];
  failed: CleanRefusal[];
  freedBytes: number;
  freeBefore: number | null;
  freeAfter: number | null;
}

function freeBytes(path: string): number | null {
  try {
    const s = statfsSync(existsSync(path) ? path : dirname(path));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function moveInto(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) throw new Error(`archive already has ${basename(dest)}`);
  try {
    renameSync(src, dest);
  } catch {
    cpSync(src, dest, { errorOnExist: true });
    rmSync(src, { force: true });
  }
}

/** Apply exactly what `scan` listed; each action re-checks its guard first. */
export function applyClean(logDir: string, scan: CleanScan, o: CleanOptions = {}): CleanResult {
  const now = o.now ?? Date.now();
  const hours = o.olderThanHours ?? 24;
  const before = freeBytes(logDir);
  const done: CleanItem[] = [];
  const failed: CleanRefusal[] = [];
  const fail = (it: CleanItem, reason: string): void => void failed.push({ category: it.category, path: it.path, owner: it.owner, reason });

  const trees = scan.items.filter((i) => i.category === "worktree");
  if (trees.length) {
    const res = gcWorktrees(logDir, hours, false, now, false, undefined, undefined, new Set(trees.map((t) => t.owner)));
    for (const t of trees) {
      const r = res.find((x) => x.id === t.owner && !x.branch);
      if (r?.archive) done.push(t);
      else fail(t, r?.skipped ?? "not archived");
    }
  }
  const statuses = loadStatuses(logDir);
  for (const it of scan.items) {
    if (it.category === "worktree") continue;
    try {
      if (it.category === "worker-files") {
        const st = statuses.find((s) => s.id === it.owner);
        if (!st || isLive(st)) throw new Error("worker is live or gone");
        const mt = statusMtime(logDir, it.owner) ?? now;
        const month = join(logDir, "archive", monthOf(mt));
        for (const p of it.paths) {
          if (lstatOrNull(p)?.isSymbolicLink()) throw new Error("symlink");
          moveInto(p, join(month, relativeTo(logDir, p)));
        }
      } else if (it.category === "supervision") {
        if (lstatOrNull(it.path)?.isSymbolicLink()) throw new Error("symlink");
        rmSync(it.path, { force: true });
      } else {
        const st = statuses.find((s) => s.id === it.owner);
        if (!st) throw new Error("owner has no status");
        const why = buildDirRefusal(it.path, st, statuses, now, hours);
        if (why) throw new Error(why);
        rmSync(it.path, { recursive: true, force: true });
      }
      done.push(it);
    } catch (e) {
      fail(it, (e as Error).message.split("\n")[0]!);
    }
  }
  const after = freeBytes(logDir);
  for (const cat of new Set(done.map((d) => d.category))) {
    const set = done.filter((d) => d.category === cat);
    appendLedger(ledgerPath(logDir), "WORKER-CLEAN", { category: cat, count: set.length, bytes: set.reduce((n, d) => n + d.bytes, 0) });
  }
  return { done, failed, freedBytes: done.reduce((n, d) => n + d.bytes, 0), freeBefore: before, freeAfter: after };
}

function relativeTo(root: string, p: string): string {
  return p.startsWith(root + sep) ? p.slice(root.length + 1) : basename(p);
}

export const fmtBytes = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function totals(items: CleanItem[]): { count: number; bytes: number; byCategory: Record<string, { count: number; bytes: number }> } {
  const byCategory: Record<string, { count: number; bytes: number }> = {};
  for (const i of items) {
    const c = (byCategory[i.category] ??= { count: 0, bytes: 0 });
    c.count++;
    c.bytes += i.bytes;
  }
  return { count: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0), byCategory };
}

/** Table lines of a scan (listed items, then refusals outside the totals, then totals). */
export function renderScan(scan: CleanScan, apply: CleanResult | null = null): string[] {
  const out: string[] = [];
  const rows = scan.items.map((i) => [i.category, fmtBytes(i.bytes), `${i.ageHours} h`, i.owner, i.rule, i.path + (i.note ? `  [${i.note}]` : "")]);
  const head = ["CATEGORY", "SIZE", "AGE", "OWNER", "RULE", "PATH"];
  const w = head.map((h, c) => Math.min(48, Math.max(h.length, ...rows.map((r) => r[c]!.length))));
  const line = (r: string[]): string => r.map((v, c) => (c === r.length - 1 ? v : v.slice(0, w[c]!).padEnd(w[c]!))).join("  ");
  if (rows.length) {
    out.push(line(head));
    for (const r of rows) out.push(line(r));
  } else out.push("nothing to clean");
  if (scan.refused.length) {
    out.push("", `refused (${scan.refused.length}, not in the totals):`);
    for (const r of scan.refused) out.push(`  ${r.category}  ${r.path}  [${r.owner}]: ${r.reason}`);
  }
  const t = totals(scan.items);
  out.push("", `${apply ? "cleaned" : "would clean"}: ${t.count} item(s), ${fmtBytes(t.bytes)}` + Object.entries(t.byCategory).map(([k, v]) => `  ${k} ${v.count}/${fmtBytes(v.bytes)}`).join(""));
  if (apply) {
    out.push(`freed (estimated): ${fmtBytes(apply.freedBytes)}`);
    if (apply.freeBefore !== null && apply.freeAfter !== null) out.push(`free space: ${fmtBytes(apply.freeBefore)} -> ${fmtBytes(apply.freeAfter)} (${apply.freeAfter >= apply.freeBefore ? "+" : "-"}${fmtBytes(Math.abs(apply.freeAfter - apply.freeBefore))})`);
    for (const f of apply.failed) out.push(`  failed ${f.category} ${f.path}: ${f.reason}`);
  } else if (scan.items.length) out.push("dry run: nothing changed; pai clean --apply with the same options acts on exactly this list");
  return out;
}
