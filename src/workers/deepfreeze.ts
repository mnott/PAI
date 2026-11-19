/**
 * deepfreeze.ts — `pai stop` (= `pai freeze --deep`) and `pai resume`: preserve ALL worker work across a reboot.
 *
 * `pai freeze` is SIGSTOP; a reboot kills every stopped process and the work in flight is gone. A deep freeze
 * instead (1) records every live worker in <PAI home>/state/deepfreeze.json (id, label, session/project, cwd/repo,
 * branch, worktree, spec, class, provider, priority, parent/children, state running|queued), (2) commits any
 * uncommitted work of each worktree on the worker's own branch as "wip: deepfreeze <timestamp>", (3) stops each
 * worker through the normal teardown (kill-tree + reap) and marks its status "deepfrozen" — not killed or failed, so
 * no failure alert, escalation or reroute ever sees it — then stops the local model servers.
 *
 * After the boot the daemon finds the record, waits until the router answers and the autostart models are up (or 5
 * min) and resumes every recorded worker in its original order and priority through `pai worker resume` (a worker
 * with a conversation) or `pai worker run --spec` (a queued one, or one without a session). A rerouted origin whose
 * continuation already finished is not resumed. `pai resume` / `pai thaw` do the same at once; `--drop` discards.
 */
import * as execFileModule from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { queueDir } from "./capacity.js";
import { readFreeze, realFreezeDeps, thawAll } from "./freeze.js";
import { appendLedger as ledgerLine } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { isChatPane, isLive, loadStatus, loadStatuses, ownsPid, saveStatus, type WorkerStatus } from "./status.js";

export interface DeepWorker {
  id: string;
  label: string;
  session?: string;
  sessionKey?: string;
  project: string;
  cwd: string;
  repo?: string;
  branch?: string | null;
  worktreeDir?: string | null;
  spec?: string | null;
  className?: string;
  provider: string;
  model?: string;
  route?: string;
  priority: "high" | "normal" | "low";
  now?: boolean;
  parent?: string;
  children: string[];
  state: "running" | "queued";
  claudeSession?: string | null;
  goals: string[];
  outputFormat?: string;
  /** Order of the original start (0 = first): resume replays in this order. */
  order: number;
  /** The WIP commit made in the worktree (sha), when there was uncommitted work. */
  wip?: string;
  /** Why the WIP commit could not be made; the worktree is left untouched then, nothing is lost. */
  wipNote?: string;
  /** Why a resume attempt did not take (a refused spawn); set by deepResume, cleared when one finally does. */
  resumeNote?: string;
}

export interface DeepRecord {
  version: 1;
  at: number;
  by: string;
  workers: DeepWorker[];
  /** Local model runtimes stopped. */
  models: string[];
}

export const deepfreezePath = (): string => process.env.PAI_DEEPFREEZE_FILE ?? paiHomePath("state", "deepfreeze.json");

export function readDeepfreeze(): DeepRecord | null {
  try {
    const r = JSON.parse(readFileSync(deepfreezePath(), "utf8")) as DeepRecord;
    return r && Array.isArray(r.workers) ? r : null;
  } catch {
    return null;
  }
}

function writeRecord(r: DeepRecord): void {
  const p = deepfreezePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2));
  renameSync(tmp, p);
  deepIdsCache = null; // a cached id set in this process must not hide the freeze
}

/** The ids a deep freeze is stopping (or has stopped): their own end paths write "deepfrozen", never "killed". */
let deepIdsCache: { at: number; ids: Set<string> } | null = null;
/** The id set behind a 2 s window: the cockpit queue path reads it per pass and the file only changes when an operator freezes. */
const DEEP_IDS_TTL_MS = 2_000;

export function deepfrozenIds(): Set<string> {
  const now = Date.now();
  if (deepIdsCache && now - deepIdsCache.at < DEEP_IDS_TTL_MS) return deepIdsCache.ids;
  const ids = new Set(readDeepfreeze()?.workers.map((w) => w.id) ?? []);
  deepIdsCache = { at: now, ids };
  return ids;
}

/**
 * True while a record waits and this daemon did not start after it (a running daemon stopped the work itself,
 * only a boot resumes): the autostart manager must not bring the local models back before the operator wants them.
 */
let resumeMode = false;
export const setDeepResumeMode = (v: boolean): void => {
  resumeMode = v;
};
export const deepfreezeHold = (): boolean => !resumeMode && existsSync(deepfreezePath());

const ts = (ms: number): string => new Date(ms).toISOString().replace(/[:.]/g, "-");

/**
 * A git call must never wait for input. On 2026-11-18 a deep-freeze test hung with the main thread stuck in
 * `execFileSync("git", …)`: an unbounded spawn inherits the operator's global config, and anything there that
 * talks to a human blocks forever with stdio piped — `core.editor=cursor` (a GUI editor git waits on when a
 * commit message is needed), a credential helper (GCM / osxkeychain popping a dialog or asking for a username),
 * an LFS `filter-process` daemon reading stdin, or a repo hook. A half-dead git can also leave an index.lock
 * behind, and the next call in that repo waits on it. So every git spawn gets: no terminal prompt (a credential
 * ask fails instead of asking), a non-interactive editor, no askpass GUI, `-c core.hooksPath=` so repo hooks
 * never run, and a hard timeout with SIGKILL — bounded, and the error names the command.
 */
export const GIT_NO_INPUT_ARGS = ["-c", "core.hooksPath=", "-c", "commit.gpgsign=false"] as const;

/** Env that makes git unaskable: no terminal prompt, no askpass GUI, a non-interactive editor, an isolated temp HOME (no global config: the operator's `core.editor=cursor` and credential helpers are exactly what blocks). */
export function gitNoInputEnv(homeDir = mkdtempSync(join(tmpdir(), "pai-git-home-"))): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GIT_EDITOR: "true", HOME: homeDir, XDG_CONFIG_HOME: join(homeDir, ".config") };
}

/** Run git with the no-input env; never waits for a human; throws after `timeoutMs` (default 20 s) with the command in the message. */
export function gitNoInput(cwd: string, args: string[], opts: { timeoutMs?: number } = {}): string {
  const { execFileSync } = execFileModule as typeof import("node:child_process");
  const timeoutMs = opts.timeoutMs ?? 20_000;
  try {
    return execFileSync("git", [...GIT_NO_INPUT_ARGS, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitNoInputEnv(), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    const x = e as { stderr?: string; stdout?: string; message?: string; signal?: string };
    if (x.signal === "SIGKILL") throw new Error(`git ${args.join(" ")} timed out after ${timeoutMs / 1000}s in ${cwd} (killed — it was waiting for something)`);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${`${x.stderr ?? ""}${x.stdout ?? ""}` || x.message || String(e)}`.slice(0, 500));
  }
}

/** The DeepFreezeDeps.git shape: never throws — a failure is { ok:false, out: the error }. */
export function gitNoInputSafe(cwd: string, args: string[]): GitResult {
  try {
    return { ok: true, out: gitNoInput(cwd, args) };
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) };
  }
}

export interface GitResult {
  ok: boolean;
  out: string;
}

export interface DeepFreezeDeps {
  statuses: (logDir: string) => WorkerStatus[];
  owns: (s: WorkerStatus) => boolean;
  now: () => number;
  git: (cwd: string, args: string[]) => GitResult;
  /** Normal teardown of one worker (kill-tree + reap); must not throw for an already ended one. */
  stop: (logDir: string, id: string) => Promise<void>;
  /** Stop the local model servers; returns the names stopped. */
  stopModels: () => Promise<string[]>;
  /** Continue a plain `pai freeze` first: a SIGSTOPped process cannot run its teardown. */
  unfreeze: (logDir: string) => void;
  ledger: (logDir: string, event: string, kv: Record<string, string | number>) => void;
}

const priorityOf = (s: WorkerStatus): "high" | "normal" | "low" => s.priority ?? "normal";

/** What a deep freeze would preserve, in original start order. Pure given its inputs. */
export function planDeepFreeze(statuses: WorkerStatus[], owns: (s: WorkerStatus) => boolean, repoOf: (s: WorkerStatus) => string | undefined = () => undefined): DeepWorker[] {
  const live = statuses
    .filter((s) => (s.state === "running" || s.state === "queued") && !isChatPane(s) && s.origin !== "uhp" && isLive(s, (x) => owns(x as WorkerStatus)))
    .sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : a.id < b.id ? -1 : 1));
  return live.map((s, order) => ({
    id: s.id,
    label: s.label,
    ...(s.session?.name ? { session: s.session.name } : {}),
    ...(s.sessionKey ? { sessionKey: s.sessionKey } : {}),
    project: (repoOf(s) ?? s.cwd).split("/").filter(Boolean).pop() ?? "",
    cwd: s.cwd,
    ...(repoOf(s) ? { repo: repoOf(s) } : {}),
    branch: s.branch ?? null,
    worktreeDir: s.worktreeDir ?? null,
    spec: s.promptFile ?? s.spec ?? null,
    ...(s.className ? { className: s.className } : {}),
    provider: s.provider,
    ...(s.model ? { model: s.model } : {}),
    ...(s.routeWhy ? { route: s.routeWhy } : s.route ? { route: `${s.route.policy}: ${s.route.reason}` } : {}),
    priority: priorityOf(s),
    ...(s.now ? { now: true } : {}),
    ...(s.parent ? { parent: s.parent } : {}),
    children: statuses.filter((c) => c.parent === s.id).map((c) => c.id),
    state: s.state as "running" | "queued",
    claudeSession: s.claudeSession ?? null,
    goals: (s.goals ?? []).map((g) => g.text),
    ...(s.outputFormat ? { outputFormat: s.outputFormat } : {}),
    order,
  }));
}

/** Deepest first: a child before its parent, so no parent ever runs next to a stopped child. */
function stopOrder(ws: DeepWorker[]): DeepWorker[] {
  const depth = (w: DeepWorker, seen = new Set<string>()): number => {
    const p = w.parent ? ws.find((x) => x.id === w.parent) : undefined;
    return p && !seen.has(p.id) ? 1 + depth(p, new Set([...seen, w.id])) : 0;
  };
  return [...ws].sort((a, b) => depth(b) - depth(a) || b.order - a.order);
}

/**
 * Commit everything uncommitted in the worker's worktree as "wip: deepfreeze <ts>". Hooks and gpg signing are
 * disabled via `-c core.hooksPath=` / `-c commit.gpgsign=false` on every call (see GIT_NO_INPUT_ARGS): a hook or
 * an editor is exactly what waits for input, and a deep freeze runs when the machine is about to go down — it
 * cannot block on either. A failure leaves the files exactly where they are.
 */
export function wipCommit(w: DeepWorker, d: Pick<DeepFreezeDeps, "git" | "now">): void {
  const dir = w.worktreeDir;
  if (!dir || !existsSync(dir)) return;
  const st = d.git(dir, ["status", "--porcelain"]);
  if (!st.ok) {
    w.wipNote = `git status failed: ${st.out.slice(0, 120)}`;
    return;
  }
  if (!st.out.trim()) return;
  const add = d.git(dir, ["add", "-A"]);
  if (!add.ok) {
    w.wipNote = `git add failed: ${add.out.slice(0, 120)}`;
    return;
  }
  const c = d.git(dir, ["commit", "-m", `wip: deepfreeze ${ts(d.now())}`]);
  if (!c.ok) {
    w.wipNote = `commit refused (files left staged in ${dir}): ${c.out.slice(0, 160)}`;
    return;
  }
  const sha = d.git(dir, ["rev-parse", "HEAD"]);
  if (sha.ok) w.wip = sha.out.trim();
}

export interface DeepFreezeReport {
  lines: string[];
  record: DeepRecord | null;
}

/** A subset of the workers: `pai stop <id>` / `--session <name>` (and the queue panel's row and session buttons). */
export interface DeepSelect {
  ids?: string[];
  session?: string;
}
export const inSelect = (w: Pick<DeepWorker, "id" | "session">, sel: DeepSelect): boolean => (sel.ids?.includes(w.id) ?? false) || (sel.session !== undefined && w.session === sel.session);

export async function deepFreeze(logDir: string, by: string, d: DeepFreezeDeps, opts: { dryRun?: boolean; repoOf?: (s: WorkerStatus) => string | undefined; only?: DeepSelect } = {}): Promise<DeepFreezeReport> {
  if (process.env.PAI_WORKER === "1") throw new Error("a worker cannot stop its siblings (PAI_WORKER=1)");
  const existing = readDeepfreeze();
  const sel = opts.only;
  const plan = planDeepFreeze(d.statuses(logDir), d.owns, opts.repoOf).filter((w) => !sel || inSelect(w, sel));
  if (sel && !plan.length) throw new Error(`no live worker matches ${sel.session ? `session ${sel.session}` : (sel.ids ?? []).join(",")}`);
  const lines = plan.map(
    (w) => `${opts.dryRun ? "would preserve" : "preserving"} ${w.state} ${w.id} [${w.project}] ${w.label}${w.branch ? ` branch ${w.branch}` : ""}${w.priority !== "normal" ? ` ${w.priority}` : ""}${w.parent ? ` (child of ${w.parent})` : ""}`
  );
  if (opts.dryRun) {
    lines.push(`dry run: ${plan.length} workers would be recorded in ${deepfreezePath()}, WIP-committed, stopped; local models stopped`);
    return { lines, record: null };
  }
  if (existing && !sel) throw new Error(`already stopped since ${new Date(existing.at).toISOString()} (${existing.workers.length} workers recorded); \`pai resume\` or \`pai resume --drop\` first`);
  d.unfreeze(logDir);
  const record: DeepRecord = existing && sel ? { ...existing, workers: [...existing.workers, ...plan] } : { version: 1, at: d.now(), by, workers: plan, models: [] };
  // the record exists before the first worker is touched: a crash anywhere below still leaves the way back
  writeRecord(record);
  for (const w of stopOrder(plan)) {
    try {
      await d.stop(logDir, w.id);
    } catch (e) {
      lines.push(`stop ${w.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const st = loadStatus(logDir, w.id);
    if (st) {
      st.state = "deepfrozen";
      st.rc = null;
      st.last = `deepfrozen ${ts(d.now())}: resumes after the boot (pai resume)`;
      st.endReason = "deepfreeze";
      st.endBy = by;
      saveStatus(logDir, st, new Date(d.now()), true);
    }
    // after the stop: nothing writes into the tree any more
    wipCommit(w, d);
    if (w.wip) lines.push(`wip commit ${w.wip.slice(0, 8)} on ${w.branch ?? "?"} (${w.id})`);
    if (w.wipNote) lines.push(`wip ${w.id}: ${w.wipNote}`);
    writeRecord(record);
  }
  // a selective stop leaves the shared model servers running: other workers use them
  if (!sel) record.models = await d.stopModels().catch(() => []);
  writeRecord(record);
  d.ledger(ledgerPath(logDir), "WORKERS-DEEPFREEZE", { by, workers: plan.length, models: record.models.length });
  lines.push(`deep-frozen ${plan.length} workers, stopped models: ${record.models.join(", ") || "none"}; record ${deepfreezePath()}; \`pai resume\` restores (the daemon does it after the boot)`);
  return { lines, record };
}

export interface DeepResumeDeps {
  statuses: (logDir: string) => WorkerStatus[];
  /**
   * Start the continuation; resolves once its process announced its worker id — which gateStart writes
   * BEFORE the capacity gate waits for a slot. The announced run may still be waiting at the provider's
   * cap: deepResume checks the status and counts it "queued", not "started". A refused spawn throws.
   */
  start: (logDir: string, w: DeepWorker, text: string) => Promise<string>;
  setPriority: (logDir: string, id: string, w: DeepWorker) => void;
  /** Resolves true once the router answers and the autostart models are up. */
  ready: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** One PAILot line to the operator. */
  notify: (text: string) => Promise<void>;
  ledger: (logDir: string, event: string, kv: Record<string, string | number>) => void;
}

/** Why a recorded worker must not be resumed, or undefined. */
export function resumeSkip(w: DeepWorker, all: WorkerStatus[]): string | undefined {
  const origin = all.find((s) => s.id === w.id);
  if (origin?.continuedBy) return `continued by ${origin.continuedBy}`;
  const ft = origin?.fallThroughTo ? all.find((s) => s.id === origin.fallThroughTo) : undefined;
  // a rerouted origin whose continuation already finished (or still runs) is done with
  if (ft && (ft.state === "done" || ft.state === "running" || ft.state === "queued")) return `rerouted to ${ft.id} (${ft.state})`;
  const again = all.find((s) => s.resumedFrom === w.id || s.fallThroughOf === w.id);
  if (again && again.state !== "failed" && again.state !== "lost") return `already resumed as ${again.id}`;
  return undefined;
}

export function resumeText(w: DeepWorker): string {
  const goals = w.goals.length ? `\n\nGoals given to you so far:\n${w.goals.map((g) => `- ${g}`).join("\n")}` : "";
  // the continuation runs under a NEW worker id in THIS worktree (the origin's
  // tree — see resume-args.ts): name it, so the model never derives a path from its own id
  const worktree = w.worktreeDir
    ? ` Your worktree: ${w.worktreeDir} — this is where you edit files; it is not a directory named after your (new) worker id.`
    : "";
  return `The machine was stopped and restarted (pai stop / pai resume); nothing failed. Your branch ${w.branch ?? "(none)"} holds your work${w.wip ? ` (uncommitted files were saved as a "wip: deepfreeze" commit ${w.wip.slice(0, 8)})` : ""}.${worktree} Continue where you left off on: ${w.label}.${goals}`;
}

/**
 * True when the announced run holds its queue ticket at the slot gate: capacityGate writes the ticket
 * `<logDir>/queue/<provider>/<id>` (plain file, "<pid> …") while it waits for a slot and removes it at
 * the grant. A status that already says "queued" passes without touching the files.
 */
export function runIsQueued(logDir: string, id: string, provider: string, state?: string): boolean {
  if (state === "queued") return true;
  try {
    return existsSync(join(queueDir(logDir, provider), id));
  } catch {
    return false;
  }
}

/** The `pai worker run|resume` argv of one recorded worker is built by the starter; this is the replay loop. */
export async function deepResume(
  logDir: string,
  d: DeepResumeDeps,
  opts: { drop?: boolean; wait?: boolean; waitMs?: number; only?: DeepSelect } = {}
): Promise<{ lines: string[]; resumed: string[]; started: string[]; queued: string[]; skipped: string[]; failed: string[] }> {
  const rec = readDeepfreeze();
  const none = { started: [], queued: [], resumed: [], skipped: [], failed: [] };
  if (!rec) return { lines: ["nothing recorded (no deep freeze)"], ...none };
  if (opts.drop) {
    rmSync(deepfreezePath(), { force: true });
    d.ledger(ledgerPath(logDir), "WORKERS-DEEPFREEZE-DROP", { workers: rec.workers.length });
    return { lines: [`dropped the deep-freeze record (${rec.workers.length} workers not resumed)`], ...none };
  }
  if (opts.wait) {
    const end = d.now() + (opts.waitMs ?? 300_000);
    while (!(await d.ready().catch(() => false)) && d.now() < end) await d.sleep(5_000);
  }
  // statuses are re-read per entry: the earlier entries' runs are on disk by now, so a later one's skip check sees them
  const lines: string[] = [];
  const started: string[] = [];
  const queued: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const sel = opts.only;
  const left: DeepWorker[] = sel ? rec.workers.filter((w) => !inSelect(w, sel)) : [];
  if (sel && left.length === rec.workers.length) return { lines: [`nothing recorded matches ${sel.session ? `session ${sel.session}` : (sel.ids ?? []).join(",")}`], ...none };
  for (const w of [...rec.workers].filter((w) => !sel || inSelect(w, sel)).sort((a, b) => a.order - b.order)) {
    const why = resumeSkip(w, d.statuses(logDir));
    if (why) {
      skipped.push(w.id);
      lines.push(`skipped ${w.id}: ${why}`);
      continue;
    }
    try {
      // the run goes through the normal start path — one queue ticket each, ordered by the slot gate.
      // The announce (start's resolve) is NOT proof it started: gateStart announces before the gates wait
      // for a slot, so an announced id whose status never left "deepfrozen" (or vanished) never started.
      const id = await d.start(logDir, w, resumeText(w));
      try {
        d.setPriority(logDir, id, w);
      } catch {
        /* the continuation keeps its default priority */
      }
      // a worker counts as resumed only once its run actually started (status running) or waits with its
      // ticket at the gate ("queued"). Anything else — a status still deepfrozen, gone, an unknown state —
      // is not started: it stays in the record with the reason, never counted as resumed.
      const st = d.statuses(logDir).find((s) => s.id === id);
      if (st?.state === "running") {
        started.push(`${w.id}->${id}`);
        w.resumeNote = undefined;
        lines.push(`resumed ${w.id} as ${id} — started (${w.state}, ${w.priority}) ${w.label}`);
      } else if (runIsQueued(logDir, id, st?.provider ?? w.provider, st?.state)) {
        queued.push(`${w.id}->${id}`);
        w.resumeNote = undefined;
        lines.push(`resumed ${w.id} as ${id} — queued at the slot gate (${w.state}, ${w.priority}) ${w.label}`);
      } else {
        failed.push(w.id);
        left.push(w);
        w.resumeNote = `announced ${id} but its status says ${st?.state ?? "no status"}: not started`;
        lines.push(`resume ${w.id}: announced ${id} but it never started (status ${st?.state ?? "missing"}) — kept in the record`);
      }
    } catch (e) {
      failed.push(w.id);
      left.push(w);
      w.resumeNote = e instanceof Error ? e.message : String(e);
      lines.push(`resume ${w.id} failed: ${w.resumeNote}`);
    }
  }
  // the record is removed only when every selected entry started or queued (or was skipped as already
  // continued); a single entry that did not take keeps the whole record, with its reason on it.
  if (left.length) writeRecord({ ...rec, workers: left });
  else rmSync(deepfreezePath(), { force: true });
  d.ledger(ledgerPath(logDir), "WORKERS-DEEPRESUME", { started: started.length, queued: queued.length, skipped: skipped.length, failed: failed.length });
  const names = (ids: string[]): string => rec.workers.filter((w) => ids.some((r) => r.startsWith(`${w.id}->`))).map((w) => w.label.slice(0, 40)).join("; ");
  const summary = `PAI resume after the stop: started ${started.length}, queued ${queued.length}${skipped.length ? `, skipped ${skipped.length} (already continued)` : ""}${failed.length ? `, ${failed.length} failed (record kept: pai resume — ${left.filter((w) => failed.includes(w.id)).map((w) => `${w.id}: ${w.resumeNote ?? "not started"}`).join("; ")})` : ""}${started.length + queued.length ? `: ${names([...started, ...queued])}` : ""}`;
  lines.push(summary);
  await d.notify(summary).catch(() => undefined);
  return { lines, resumed: [...started, ...queued], started, queued, skipped, failed };
}

/** The recorded repo of a status: the git common dir's parent of its worktree. */
export function realRepoOf(s: WorkerStatus, git: DeepFreezeDeps["git"]): string | undefined {
  const dir = s.worktreeDir && existsSync(s.worktreeDir) ? s.worktreeDir : undefined;
  if (!dir) return undefined;
  const r = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r.ok ? dirname(r.out.trim()) : undefined;
}

export async function realDeepFreezeDeps(): Promise<DeepFreezeDeps> {
  return {
    statuses: (dir) => loadStatuses(dir),
    owns: (s) => ownsPid(s),
    now: () => Date.now(),
    git: gitNoInputSafe,
    stop: async (dir, id) => {
      const { killTree } = await import("./kill-tree.js");
      await killTree(dir, id, { only: true, by: "deepfreeze", reason: "deep freeze: resumes after the boot" });
    },
    stopModels: async () => {
      const stopped: string[] = [];
      try {
        const { readRuntimeCommands } = await import("./model-runtimes.js");
        const { liveAutostartDeps } = await import("../daemon/runtime-autostart.js");
        const { defaultDeps, runtimeStartStop } = await import("../router/cockpit-actions.js");
        const up = liveAutostartDeps();
        for (const [name, c] of Object.entries(readRuntimeCommands())) {
          if (!c.stop || !(await up.isUp(name).catch(() => false))) continue;
          const r = await runtimeStartStop(name, "stop", defaultDeps());
          if (r.ok) stopped.push(name);
        }
        if (!stopped.length) {
          const { runningModelServers } = await import("./model-servers.js");
          for (const m of await runningModelServers()) {
            try {
              process.kill(m.pid, "SIGTERM");
              stopped.push(m.label);
            } catch {
              /* gone */
            }
          }
        }
      } catch {
        /* models stay up; the workers are preserved regardless */
      }
      return stopped;
    },
    unfreeze: (dir) => {
      if (readFreeze()) thawAll(dir, realFreezeDeps());
    },
    ledger: (p, e, kv) => {
      try {
        ledgerLine(p, e, kv);
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * One recorded worker's restart on the normal start path (`pai worker resume|run`, detached): the run gets
 * its queue ticket at the slot gate like any other start. `startDetachedWorker` resolves at the announce —
 * written before the gates wait for a slot — so a status still "starting" is re-read briefly: by the end of
 * the grace the announced run is either running, parked at the gate with its ticket ("queued"), or dead.
 */
async function startOne(dir: string, w: DeepWorker, text: string, detached: typeof import("./reroute.js")["startDetachedWorker"]): Promise<string> {
  const resumable = w.state === "running" && !!w.claudeSession;
  const args = resumable
    // a queued worker restarted with `run` gets no worktree prompt of its own: name the tree it runs in
    ? ["resume", w.id, text, "--label", `↩ ${w.label}`]
    : [
        "run",
        "--provider",
        w.provider,
        ...(w.model ? ["--model", w.model] : []),
        "--label",
        w.label,
        ...(w.className ? ["--class", w.className] : []),
        ...(w.cwd ? ["--cwd", w.cwd] : []),
        // the task goes in as -p; when a worktree still stands, prepend the notice naming it
        // (a `run` restart builds no worktree prompt of its own)
        ...(w.worktreeDir && existsSync(w.worktreeDir)
          ? ["-p", `(Your worktree: ${w.worktreeDir} — the tree your run continues in; edit files there. It is not a directory named after your own worker id.)\n\n${text}`]
          : ["-p", text]),
      ];
  if (!resumable && !(w.spec && existsSync(w.spec))) throw new Error("no spec file kept for this worker");
  const id = await detached(dir, args, { cwd: existsSync(w.cwd) ? w.cwd : process.cwd(), timeoutMs: 60_000 });
  // the announce precedes the gates; give the run a bounded moment to record its real state (running or queued)
  const graceMs = 5_000;
  const until = Date.now() + graceMs;
  for (;;) {
    const st = loadStatus(dir, id);
    if (!st || st.last !== "starting") return id; // running / queued / an end state: deepResume judges it
    if (Date.now() >= until) return id;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Real resume deps: continuation via the detached `pai worker resume|run` (same path as the operator's). */
export async function realDeepResumeDeps(): Promise<DeepResumeDeps> {
  const { startDetachedWorker } = await import("./reroute.js");
  const { setWorkerPriority } = await import("./engine-control.js");
  // one spawn at a time (deepResume replays sequentially, awaiting each start): all nine fired at once
  // on 2026-11-19 and only the first survived the boot's admission; a refused spawn leaves the record intact.
  let last: Promise<void> = Promise.resolve();
  return {
    statuses: (dir) => loadStatuses(dir),
    start: async (dir, w, text) => {
      const prev = last;
      let settle!: () => void;
      last = new Promise<void>((r) => (settle = r));
      await prev.catch(() => undefined); // the previous entry is fully handled before this one spawns
      try {
        return await startOne(dir, w, text, startDetachedWorker);
      } finally {
        settle();
      }
    },
    setPriority: (dir, id, w) => {
      if (w.priority !== "normal") setWorkerPriority(dir, id, w.priority, "deepresume");
    },
    ready: async () => {
      const { probeRouter } = await import("../router/supervisor.js");
      if (!(await probeRouter())) return false;
      const { liveRuntimeAutostartConfig, liveAutostartDeps } = await import("../daemon/runtime-autostart.js");
      const up = liveAutostartDeps();
      for (const name of Object.keys(liveRuntimeAutostartConfig().runtimes)) if (!(await up.isUp(name).catch(() => false))) return false;
      return true;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    notify: async (text) => {
      const { callAiBroker } = await import("../cli/lib/aibroker-client.js");
      await callAiBroker("pailot_send", { text }, 8_000);
    },
    ledger: (p, e, kv) => {
      try {
        ledgerLine(p, e, kv);
      } catch {
        /* best effort */
      }
    },
  };
}

