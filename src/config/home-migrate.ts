/**
 * home-migrate.ts — `pai home migrate`: move PAI's home out of the Claude Code
 * directory (~/.claude/pai) into ~/.pai. See docs/pai-home.md.
 *
 * Same-volume rename, never copy. ~/.pai/pgdata (the Postgres data dir) is
 * never touched. Leftovers of earlier moves (*.migrated-*, *.bak*, tarballs)
 * go to ~/.pai/attic/<date>/. The old path stays behind as a symlink.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Entries that must never be moved or overwritten. */
const PROTECTED = new Set(["pgdata", "attic"]);

const LEFTOVER = /(\.migrated-[^/]*|\.bak(-[^/]*)?|\.tar|\.tar\.gz|\.tgz)$/;

/** Finder droppings are junk, not state: they go to the attic rather than clash with the other home's copy. */
export const isLeftover = (name: string): boolean => LEFTOVER.test(name) || name === ".DS_Store";

export interface MoveStep {
  name: string;
  from: string;
  to: string;
  kind: "move" | "attic";
}

export interface RewriteStep {
  file: string;
  occurrences: number;
}

export interface HomeMigrationPlan {
  src: string;
  dst: string;
  attic: string;
  /** Nothing to do (already migrated or no legacy dir), with the reason. */
  skip?: string;
  moves: MoveStep[];
  /** Names present in both the legacy home and ~/.pai (stops the run). */
  clashes: string[];
  rewrites: RewriteStep[];
}

export interface PlanOpts {
  home: string;
  /** YYYYMMDD */
  date: string;
}

/** `~/.claude/pai` and `<home>/.claude/pai` references become the new home; anything else is untouched. */
export function rewritePaiPaths(text: string, home: string): { text: string; count: number } {
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:~|\\$HOME|\\$\\{HOME\\}|${esc})/\\.claude/pai(?![\\w.-])`, "g");
  let count = 0;
  const out = text.replace(re, (m) => {
    count++;
    return m.slice(0, m.length - "/.claude/pai".length) + "/.pai";
  });
  return { text: out, count };
}

/** PAI-owned text files whose absolute paths are rewritten (relative to the new home, plus generated launchd plists). */
function rewriteCandidates(home: string): string[] {
  const out = ["config.yaml", "config.json", "workers.yaml", "voices.yaml"].map((n) => join(home, ".pai", n));
  const agents = join(home, "Library", "LaunchAgents");
  if (existsSync(agents)) {
    for (const n of readdirSync(agents)) if (/^com\.pai\..*\.plist$/.test(n)) out.push(join(agents, n));
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function planHomeMigration(opts: PlanOpts): HomeMigrationPlan {
  const src = join(opts.home, ".claude", "pai");
  const dst = join(opts.home, ".pai");
  const attic = join(dst, "attic", opts.date);
  const plan: HomeMigrationPlan = { src, dst, attic, moves: [], clashes: [], rewrites: [] };

  let srcStat;
  try {
    srcStat = lstatSync(src);
  } catch {
    plan.skip = `${src} does not exist — nothing to migrate`;
    return plan;
  }
  if (srcStat.isSymbolicLink()) {
    plan.skip = `${src} is already a symlink — already migrated`;
    return plan;
  }
  if (!srcStat.isDirectory()) {
    plan.skip = `${src} is not a directory`;
    return plan;
  }

  const dstEntries = isDir(dst) ? readdirSync(dst) : [];
  const dstStays = new Set<string>();
  const atticNames = new Set<string>();

  // Leftovers already in ~/.pai go to the attic first.
  for (const name of dstEntries) {
    if (PROTECTED.has(name)) {
      dstStays.add(name);
    } else if (LEFTOVER.test(name)) {
      plan.moves.push({ name, from: join(dst, name), to: join(attic, name), kind: "attic" });
      atticNames.add(name);
    } else {
      dstStays.add(name);
    }
  }

  for (const name of readdirSync(src)) {
    const from = join(src, name);
    if (isLeftover(name) && !PROTECTED.has(name)) {
      if (atticNames.has(name) || existsSync(join(attic, name))) plan.clashes.push(`attic/${opts.date}/${name}`);
      else {
        atticNames.add(name);
        plan.moves.push({ name, from, to: join(attic, name), kind: "attic" });
      }
      continue;
    }
    if (dstStays.has(name)) {
      plan.clashes.push(name);
      continue;
    }
    plan.moves.push({ name, from, to: join(dst, name), kind: "move" });
  }

  // Path rewrites: look at where each file will live (or already lives) after the move.
  for (const file of rewriteCandidates(opts.home)) {
    const base = file.startsWith(dst + "/") ? file.slice(dst.length + 1) : null;
    const readFrom =
      base && !existsSync(file) && existsSync(join(src, base)) && !plan.clashes.includes(base) ? join(src, base) : file;
    if (!existsSync(readFrom)) continue;
    const { count } = rewritePaiPaths(readFileSync(readFrom, "utf8"), opts.home);
    if (count > 0) plan.rewrites.push({ file, occurrences: count });
  }
  return plan;
}

export interface ApplyResult {
  moved: number;
  rewritten: number;
}

/** Execute a plan. Throws (changing nothing) on clashes or a cross-volume home. */
export function applyHomeMigration(plan: HomeMigrationPlan, home: string): ApplyResult {
  if (plan.skip) return { moved: 0, rewritten: 0 };
  if (plan.clashes.length) throw new Error(`name clashes, nothing changed: ${plan.clashes.join(", ")}`);
  mkdirSync(plan.dst, { recursive: true });
  if (statSync(plan.src).dev !== statSync(plan.dst).dev) {
    throw new Error(`${plan.src} and ${plan.dst} are on different volumes — rename impossible, nothing changed`);
  }
  if (plan.moves.some((m) => m.kind === "attic")) mkdirSync(plan.attic, { recursive: true });
  for (const m of plan.moves) renameSync(m.from, m.to);

  // Everything is out of the legacy dir: replace it with the compatibility symlink.
  if (readdirSync(plan.src).length === 0) {
    rmdirSync(plan.src);
    symlinkSync(plan.dst, plan.src);
  } else {
    throw new Error(`${plan.src} is not empty after the move — symlink not created`);
  }

  let rewritten = 0;
  for (const r of plan.rewrites) {
    const text = readFileSync(r.file, "utf8");
    const out = rewritePaiPaths(text, home);
    if (out.count > 0) {
      writeFileSync(r.file, out.text);
      rewritten++;
    }
  }
  return { moved: plan.moves.length, rewritten };
}

/** Disk usage in bytes of a path (du -sk); null when unreadable. */
export function sizeOf(path: string): number | null {
  let out = "";
  try {
    out = execFileSync("du", ["-sk", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 });
  } catch (e) {
    // du exits non-zero on a file that vanished mid-walk (live logs) but still prints the total
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const kb = parseInt(out.split(/\s/)[0] ?? "", 10);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

export function fmtSize(n: number | null): string {
  if (n === null) return "?";
  const u = ["B", "K", "M", "G", "T"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
}

/** The before/after table: one row per moved entry plus the protected ones left alone. */
export function renderTable(plan: HomeMigrationPlan, size: (p: string) => number | null, home: string): string {
  const tilde = (p: string) => (p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
  const rows: string[][] = [["entry", "size", "before", "after"]];
  for (const m of plan.moves) rows.push([m.name, fmtSize(size(m.from)), tilde(m.from), tilde(m.to)]);
  const pg = join(plan.dst, "pgdata");
  if (existsSync(pg)) rows.push(["pgdata", fmtSize(size(pg)), tilde(pg), tilde(pg) + "  (untouched)"]);
  rows.push([tilde(plan.src), "-", "directory", "symlink -> " + tilde(plan.dst)]);
  const w = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => (c === 1 ? cell.padStart(w[c]!) : cell.padEnd(w[c]!))).join("  ").trimEnd()).join("\n");
}
