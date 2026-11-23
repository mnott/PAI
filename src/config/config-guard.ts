/**
 * config-guard.ts — a config edit reverts itself unless it is proven working.
 *
 * `arm` snapshots config.yaml / workers.yaml (byte for byte) into
 * <PAI_HOME>/logs/config-guard/<ts>-<file> and records a deadline in
 * <PAI_HOME>/config-guard.json. `confirm` runs the proof; a pass clears the
 * deadline, a fail restores the snapshot at once. The daemon's scheduler ticks
 * `tickConfigGuard`: a deadline that passed without a confirm restores the
 * snapshot, reloads what reads it and tells the operator once.
 * Design notes: docs/config.md ("Config guard").
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { paiConfigFilePath } from "../daemon/config.js";
import { yamlSiblingPath } from "./main-config.js";
import { workersYamlPath } from "../workers/workers-config.js";
import { paiHomePath } from "./pai-home.js";
import { assertTestWriteAllowed } from "./test-isolation.js";

export const DEFAULT_GUARD_WINDOW_MS = 10 * 60_000;
export type GuardFile = "config.yaml" | "workers.yaml";
export const GUARD_FILES: GuardFile[] = ["config.yaml", "workers.yaml"];

export interface GuardEntry {
  file: GuardFile;
  /** the live file this entry protects */
  path: string;
  /** the snapshot copy; null when the file did not exist at arm time (restore deletes it) */
  snapshot: string | null;
  armedAt: number;
  deadline: number;
  /** set by the auto-arm of a command: that command disarms it itself */
  auto?: boolean;
}

export const guardStatePath = (): string => paiHomePath("config-guard.json");
const snapshotDir = (): string => paiHomePath("logs", "config-guard");

export function liveGuardPath(file: GuardFile): string {
  return file === "config.yaml" ? yamlSiblingPath(paiConfigFilePath()) : workersYamlPath();
}

/** What the last guarded change ended as; the cockpit shows it until the next change. */
export interface GuardOutcome {
  outcome: "kept" | "reverted";
  reason: string;
  files: GuardFile[];
  at: number;
}

interface GuardStateFile {
  entries: GuardEntry[];
  last?: GuardOutcome;
}

function readStateFile(): GuardStateFile {
  try {
    const raw = JSON.parse(readFileSync(guardStatePath(), "utf8")) as Partial<GuardStateFile>;
    return { entries: Array.isArray(raw.entries) ? raw.entries : [], ...(raw.last ? { last: raw.last } : {}) };
  } catch {
    return { entries: [] };
  }
}

export function readGuardState(): GuardEntry[] {
  return readStateFile().entries;
}

export function readGuardOutcome(): GuardOutcome | undefined {
  return readStateFile().last;
}

function writeGuardState(entries: GuardEntry[], last?: GuardOutcome): void {
  const p = guardStatePath();
  assertTestWriteAllowed(p);
  mkdirSync(dirname(p), { recursive: true });
  const keep = last ?? readStateFile().last;
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ entries, ...(keep ? { last: keep } : {}) }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
}

const hhmm = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/** The cockpit line: 'pending confirm, reverts at HH:MM' / 'change kept: proven' / 'reverted: <reason>' (empty: nothing to say). */
export function guardStatusText(): { state: "pending" | "kept" | "reverted" | "none"; text: string } {
  const st = readStateFile();
  if (st.entries.length) {
    const at = Math.min(...st.entries.map((e) => e.deadline));
    return { state: "pending", text: `pending confirm, reverts at ${hhmm(at)}` };
  }
  if (st.last) return { state: st.last.outcome, text: st.last.outcome === "kept" ? "change kept: proven" : `reverted: ${st.last.reason}` };
  return { state: "none", text: "" };
}

/** "10m", "90s", "2h", or a bare number of minutes → ms. */
export function parseWindow(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`bad window "${s}" (use e.g. 90s, 10m, 1h)`);
  const n = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "m") as "s" | "m" | "h"];
  if (!(n > 0)) throw new Error(`bad window "${s}"`);
  return n;
}

/** Snapshot the files (default: both) and start the deadline. An already armed file keeps its ORIGINAL snapshot (the
 *  known-good state) and only gets a later deadline. */
export function armConfigGuard(opts: { files?: GuardFile[]; forMs?: number; now?: number; auto?: boolean; paths?: Partial<Record<GuardFile, string>> } = {}): GuardEntry[] {
  const now = opts.now ?? Date.now();
  const forMs = opts.forMs ?? DEFAULT_GUARD_WINDOW_MS;
  const entries = readGuardState();
  const armed: GuardEntry[] = [];
  for (const file of opts.files ?? GUARD_FILES) {
    const path = opts.paths?.[file] ?? liveGuardPath(file);
    const have = entries.find((e) => e.file === file);
    if (have) {
      have.deadline = Math.max(have.deadline, now + forMs);
      // a manual arm takes over an auto entry: the command that auto-armed it is not the one confirming
      if (!opts.auto) have.auto = false;
      armed.push(have);
      continue;
    }
    let snapshot: string | null = null;
    if (existsSync(path)) {
      mkdirSync(snapshotDir(), { recursive: true });
      snapshot = join(snapshotDir(), `${new Date(now).toISOString().replace(/[:.]/g, "-")}-${file}`);
      assertTestWriteAllowed(snapshot);
      copyFileSync(path, snapshot);
      chmodSync(snapshot, 0o600);
    }
    const e: GuardEntry = { file, path, snapshot, armedAt: now, deadline: now + forMs, ...(opts.auto ? { auto: true } : {}) };
    entries.push(e);
    armed.push(e);
  }
  writeGuardState(entries);
  return armed;
}

function restoreEntry(e: GuardEntry): void {
  assertTestWriteAllowed(e.path);
  if (e.snapshot === null) {
    try { unlinkSync(e.path); } catch { /* already gone */ }
    return;
  }
  const bytes = readFileSync(e.snapshot);
  const tmp = `${e.path}.tmp-guard-${process.pid}`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, e.path);
  chmodSync(e.path, 0o600);
}

/** Restore the given entries (default all) and clear them from the state. Returns the restored files. */
export function revertConfigGuard(files?: GuardFile[], reason = "reverted"): GuardEntry[] {
  const entries = readGuardState();
  const hit = entries.filter((e) => !files || files.includes(e.file));
  for (const e of hit) restoreEntry(e);
  writeGuardState(entries.filter((e) => !hit.includes(e)), hit.length ? { outcome: "reverted", reason, files: hit.map((e) => e.file), at: Date.now() } : undefined);
  return hit;
}

/** Clear the deadlines, keep the changes. */
export function disarmConfigGuard(files?: GuardFile[], kept = true): GuardEntry[] {
  const entries = readGuardState();
  const hit = entries.filter((e) => !files || files.includes(e.file));
  writeGuardState(entries.filter((e) => !hit.includes(e)), kept && hit.length ? { outcome: "kept", reason: "proven", files: hit.map((e) => e.file), at: Date.now() } : undefined);
  return hit;
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

export interface ProofCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ProofDeps {
  /** the config loader the daemon/router use, run against the files on disk; throws on a rejected config */
  load: () => void;
  daemonHealth: () => Promise<boolean>;
  routerHealth: () => Promise<boolean>;
  /** GET path on the router; the HTTP status (0 = no answer) */
  routerGet: (path: string) => Promise<number>;
  /** runtimes marked running that do not accept connections */
  unreachableRuntimes: () => Promise<string[]>;
}

async function safe(f: () => Promise<boolean> | boolean): Promise<{ ok: boolean; detail?: string }> {
  try {
    return { ok: await f() };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function runConfigProof(deps: ProofDeps, files: GuardFile[] = GUARD_FILES, paths: Partial<Record<GuardFile, string>> = {}): Promise<ProofCheck[]> {
  const out: ProofCheck[] = [];
  for (const f of files) {
    const p = paths[f] ?? liveGuardPath(f);
    let detail: string | undefined;
    let ok = true;
    if (existsSync(p)) {
      const doc = parseDocument(readFileSync(p, "utf8"));
      if (doc.errors.length) { ok = false; detail = doc.errors[0].message; }
    }
    out.push({ name: `yaml:${f}`, ok, ...(detail ? { detail } : {}) });
  }
  const load = await safe(() => { deps.load(); return true; });
  out.push({ name: "loader", ...load });
  // a rejected config makes the service checks meaningless (and a config-reading probe may throw): stop at the loader
  if (!out.every((c) => c.ok)) return out;
  out.push({ name: "daemon-health", ...(await safe(deps.daemonHealth)) });
  out.push({ name: "router-health", ...(await safe(deps.routerHealth)) });
  out.push({ name: "router:/v1/models", ...(await safe(async () => { const st = await deps.routerGet("/v1/models"); return st >= 200 && st < 500; })) });
  out.push({ name: "router:/cockpit", ...(await safe(async () => { const s = await deps.routerGet("/cockpit"); return s >= 200 && s < 500; })) });
  const down = await safe(async () => {
    const d = await deps.unreachableRuntimes();
    if (d.length) throw new Error(`unreachable: ${d.join(", ")}`);
    return true;
  });
  out.push({ name: "runtimes", ...down });
  return out;
}

export const proofFailures = (checks: ProofCheck[]): ProofCheck[] => checks.filter((c) => !c.ok);

export interface ConfirmResult {
  ok: boolean;
  checks: ProofCheck[];
  reverted: GuardFile[];
  /** nothing was armed */
  idle: boolean;
}

/** Run the proof. Pass → clear the deadline, keep the change. Fail → restore the snapshot now (and reload). */
export async function confirmConfigGuard(
  deps: ProofDeps,
  onReverted?: (files: GuardFile[]) => Promise<void> | void,
  opts: { files?: GuardFile[]; ignore?: Set<string>; paths?: Partial<Record<GuardFile, string>> } = {}
): Promise<ConfirmResult> {
  const armed = readGuardState().filter((e) => !opts.files || opts.files.includes(e.file));
  const checks = await runConfigProof(deps, opts.files ?? GUARD_FILES, opts.paths);
  const failed = proofFailures(checks).filter((c) => !opts.ignore?.has(c.name));
  if (!armed.length) return { ok: failed.length === 0, checks, reverted: [], idle: true };
  if (!failed.length) {
    disarmConfigGuard(armed.map((e) => e.file));
    return { ok: true, checks, reverted: [], idle: false };
  }
  const why = failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("; ");
  const reverted = revertConfigGuard(armed.map((e) => e.file), why).map((e) => e.file);
  await onReverted?.(reverted);
  return { ok: false, checks, reverted, idle: false };
}

export interface TickDeps {
  now: () => number;
  reload: (files: GuardFile[]) => Promise<void> | void;
  notify: (text: string) => Promise<void> | void;
  log: (line: string) => void;
}

/** Daemon tick: restore every entry whose deadline passed, reload, log, one notice per tick. */
export async function tickConfigGuard(d: TickDeps): Promise<GuardFile[]> {
  const now = d.now();
  const due = readGuardState().filter((e) => e.deadline <= now);
  if (!due.length) return [];
  const files = revertConfigGuard(due.map((e) => e.file), "deadline passed without confirm").map((e) => e.file);
  d.log(`[config-guard] deadline passed without confirm: restored ${files.join(", ")}`);
  try { await d.reload(files); } catch (e) { d.log(`[config-guard] reload failed: ${e instanceof Error ? e.message : String(e)}`); }
  try {
    await d.notify(`PAI config guard: ${files.join(" and ")} changed and was not confirmed working in time, so the previous version (${due.map((e) => basename(e.snapshot ?? "absent")).join(", ")}) was restored.`);
  } catch { /* the log line carries it */ }
  return files;
}

/**
 * Run a config edit under the guard: arm, run `edit`, prove, keep or revert. Used by `pai config set/unset`, the
 * cockpit saves and the other PAI edit paths. The proof only counts checks that passed BEFORE the edit, so a daemon
 * that is simply not running does not make every `pai config set` revert itself. A thrown edit, or one `wrote` says
 * wrote nothing, leaves nothing to revert.
 */
export async function guardedEdit<T>(
  edit: () => T,
  deps: ProofDeps,
  onReverted?: (files: GuardFile[]) => Promise<void> | void,
  opts: { files?: GuardFile[]; paths?: Partial<Record<GuardFile, string>>; wrote?: (v: T) => boolean } = {}
): Promise<{ value: T; reverted: boolean; checks: ProofCheck[]; reason?: string }> {
  const files = opts.files ?? GUARD_FILES;
  const mine = files.filter((f) => !readGuardState().some((e) => e.file === f));
  const before = await runConfigProof(deps, files, opts.paths);
  const ignore = new Set(proofFailures(before).map((c) => c.name));
  armConfigGuard({ auto: true, files, paths: opts.paths });
  let value: T;
  try {
    value = edit();
  } catch (e) {
    disarmConfigGuard(mine, false);
    throw e;
  }
  if (opts.wrote && !opts.wrote(value)) {
    disarmConfigGuard(mine, false);
    return { value, reverted: false, checks: [] };
  }
  const r = await confirmConfigGuard(deps, onReverted, { files: mine, ignore, paths: opts.paths });
  const reason = readGuardOutcome()?.reason;
  return { value, reverted: r.reverted.length > 0, checks: r.checks, ...(r.reverted.length && reason ? { reason } : {}) };
}
