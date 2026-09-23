/**
 * pai-home.ts — the PAI_HOME namespace directory and generic per-user file
 * migration into it.
 *
 * Every PAI-owned per-user file (workers.yaml, config.json, whisper-rules.md,
 * advisor-mode.json, ...) lives under PAI_HOME (~/.claude/pai by default) so
 * nothing PAI writes can ever collide with a file Claude Code itself
 * introduces under ~/.claude. Decided 2026-09-19 — see docs/workers-config.md.
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Byte-identical check that works for files of any size. `cmp` compares by
 * streaming rather than loading either file into memory, unlike a
 * readFileSync + Buffer.compare — which throws ("File size is greater than
 * 2 GiB") on anything past Node's 2GiB single-read ceiling, a real limit hit
 * migrating a multi-gigabyte legacy federation database file.
 */
function filesByteIdentical(a: string, b: string): boolean {
  try {
    execFileSync("cmp", ["-s", a, b], { stdio: "pipe" });
    return true;
  } catch (e) {
    if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 1) return false;
    // cmp missing or errored for an unrelated reason — fall back to an
    // in-memory compare (fine for the small files this path normally sees).
    return Buffer.compare(readFileSync(a), readFileSync(b)) === 0;
  }
}

/** PAI_HOME (test isolation, power users) overrides the default namespace dir. */
export function paiHomeDir(): string {
  return process.env.PAI_HOME || join(homedir(), ".claude", "pai");
}

/** A path under PAI_HOME, e.g. `paiHomePath("config.json")`. */
export function paiHomePath(...segments: string[]): string {
  return join(paiHomeDir(), ...segments);
}

const noticesPrinted = new Set<string>();

/**
 * Resolve a per-user PAI file: the new PAI_HOME path if it exists, else the
 * first existing entry in `oldCandidates` (checked in order — most recent
 * old location first), else the new path (the target a first write
 * creates). Prints one stderr notice per process per new-path when a
 * fallback location is actually used.
 */
export function resolvePaiFile(newPath: string, oldCandidates: string[], migrateHint: string): string {
  if (existsSync(newPath)) return newPath;
  for (const old of oldCandidates) {
    if (existsSync(old)) {
      if (!noticesPrinted.has(newPath)) {
        noticesPrinted.add(newPath);
        process.stderr.write(
          `pai: ${old} is at an old location — run \`${migrateHint}\` to move it to ${newPath}\n`
        );
      }
      return old;
    }
  }
  return newPath;
}

export class PaiFileMigrationError extends Error {}

export interface MigrateFileResult {
  fromPath: string | null;
  toPath: string;
  dryRun: boolean;
  note?: string;
}

/**
 * Move a per-user PAI file to its new PAI_HOME location: copy, verify
 * byte-identical, then rename the source to `<name>.migrated-<YYYYMMDD>`
 * (never deleted). Idempotent: if the new path already holds bytes
 * identical to the found source, the source is just renamed aside; if it
 * differs, this refuses rather than overwrite silently.
 */
export function migratePaiFile(
  newPath: string,
  oldCandidates: string[],
  opts: { dryRun?: boolean } = {}
): MigrateFileResult {
  const fromPath = oldCandidates.find((p) => existsSync(p)) ?? null;
  if (!fromPath) {
    const note = existsSync(newPath) ? "already at new location" : "nothing to migrate — file does not exist yet";
    return { fromPath: null, toPath: newPath, dryRun: !!opts.dryRun, note };
  }
  if (opts.dryRun) return { fromPath, toPath: newPath, dryRun: true };

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  if (existsSync(newPath)) {
    if (filesByteIdentical(fromPath, newPath)) {
      renameSync(fromPath, `${fromPath}.migrated-${stamp}`);
      return { fromPath, toPath: newPath, dryRun: false, note: "identical — old file renamed aside" };
    }
    throw new PaiFileMigrationError(
      `${newPath} already exists and differs from ${fromPath} — resolve manually, nothing changed`
    );
  }

  const dir = dirname(newPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  copyFileSync(fromPath, newPath);

  if (!filesByteIdentical(fromPath, newPath)) {
    throw new PaiFileMigrationError(
      `${newPath}: copy did not match ${fromPath} byte-for-byte — aborting, old file left in place`
    );
  }

  renameSync(fromPath, `${fromPath}.migrated-${stamp}`);
  return { fromPath, toPath: newPath, dryRun: false };
}

export interface MigrateDirResult {
  fromDir: string | null;
  toDir: string;
  dryRun: boolean;
  movedCount?: number;
  note?: string;
}

/**
 * Move a per-user PAI directory (queries/, session-state/, ...) into
 * PAI_HOME: move every entry from the first found old candidate into the
 * new dir (never overwriting an existing entry there), then rename the now-
 * empty old dir aside to `<name>.migrated-<YYYYMMDD>` (never deleted).
 * Idempotent — an already-migrated dir has nothing left to find.
 */
export function migratePaiDir(
  newDir: string,
  oldCandidates: string[],
  opts: { dryRun?: boolean } = {}
): MigrateDirResult {
  const fromDir = oldCandidates.find((p) => existsSync(p) && statSync(p).isDirectory()) ?? null;
  if (!fromDir) {
    const note = existsSync(newDir) ? "already at new location" : "nothing to migrate — directory does not exist yet";
    return { fromDir: null, toDir: newDir, dryRun: !!opts.dryRun, note };
  }

  const entries = readdirSync(fromDir);
  if (opts.dryRun) return { fromDir, toDir: newDir, dryRun: true, movedCount: entries.length };

  if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });

  let moved = 0;
  const collided: string[] = [];
  for (const entry of entries) {
    const src = join(fromDir, entry);
    const dst = join(newDir, entry);
    if (existsSync(dst)) {
      collided.push(entry);
      continue;
    }
    renameSync(src, dst);
    moved++;
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const remaining = readdirSync(fromDir);
  const note = collided.length
    ? `${collided.length} entrie(s) left in ${fromDir} — name already existed in ${newDir}`
    : undefined;

  if (remaining.length === 0) {
    renameSync(fromDir, `${fromDir}.migrated-${stamp}`);
  }

  return { fromDir, toDir: newDir, dryRun: false, movedCount: moved, note };
}
