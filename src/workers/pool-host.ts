/**
 * pool-host.ts — the detached host that owns the pool's slot processes.
 *
 * Started by `pai worker pool on` (bundled standalone, see
 * standalone/pool-host.ts, same pattern as the openai proxy), it listens on
 * a loopback port and serves:
 *
 *   POST /task    — run one task as the next user turn of a warm slot
 *   GET  /healthz — liveness (the client's fast fallback probe)
 *   GET  /status  — the pool state as JSON
 *   POST /shutdown— kill every slot and exit (`pai worker pool off`)
 *
 * The host does the full per-task worker bookkeeping a fresh spawn would
 * have done: status file, <id>.jsonl event mirror, WORKER-START/END ledger
 * lines, AG2 contract trailer, report parse + validation + one bounded
 * re-ask, proof check against the Bash calls of this task's turn, and the
 * cache-carry metric line. What it cannot do per task is change the slot's
 * system prompt, MCP config, tool grants or cwd — all fixed at spawn, which
 * is exactly what the client's eligibility gate (poolIneligibleReason)
 * screens for.
 */

import { refuseUnlessLoopback } from "../utils/loopback-guard.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { openSync, closeSync, writeSync, mkdirSync, statSync, readSync, readFileSync, existsSync, rmSync } from "node:fs";
import { loadConfig } from "../daemon/config.js";
import { appendSystemPromptArgs } from "./args.js";
import { repairAndValidateAg2, validateAg2 } from "./agentish.js";
import { stripContextSuffix } from "../router/router.js";
import { getProviderOrNative, readWorkersSection, workersConfigStamp, type WorkerProvider, type WorkersConfig } from "./config.js";
import { buildRunEnv, claudeCommand, claudeSettingsExtra, isLoopbackProvider, loopbackRouterChoice, pinnedSettings } from "./run-env.js";
import { probeRouter } from "../router/supervisor.js";
import { appendLedger } from "./ledger.js";
import { resolveLocalProvider } from "./local-provider.js";
import { routeRun } from "./policy.js";
import { takeLoopStop } from "./loop-stop.js";
import { ensureNoMcpConfig, eventsPath, ledgerPath, workersLogDir } from "./paths.js";
import { nowStamp, saveStatus, loadStatus, describeTool, parseSleepSecs, type WorkerStatus } from "./status.js";
import { loadContractAddendum } from "./contract-addendum.js";
import { poolSlotSettingsId, slimProfileArgs, WORKER_BRIEF } from "./slim-profile.js";
import { removePinFilesOfProcess } from "./settings-file.js";
import {
  adoptInitModel,
  bumpContextTokens,
  ensureToolSearch,
  headlessToolGrants,
  headlessToolsFlag,
  initContextWindow,
  isCompactBoundary,
  isEmptyResponse,
  isoStamp,
  resetContextTokensOnCompact,
  stdinUserMessage,
  usageContextTokens,
  usageContextUsed,
  DEFAULT_WORKER_TOOLS,
  applyLoopStop,
  type StreamEvent,
} from "./run.js";
import type { UsageBlock } from "../utils/input-side-tokens.js";
import { POOL_SLOT_ENV, clearSlotCurrent, setSlotCurrent } from "./worker-id.js";
import {
  slotsDir,
  ensureSlotWorktree,
  prepareSlot,
  releaseSlot,
  slotPath,
  slotServesRepo,
  addSpareWorktree,
  removeSpareWorktree,
  type SlotPrep,
} from "./slots.js";
import { commitsSince, git, isPaiBookkeepingPath, salvageNotes, salvageOnExit, uncommittedPaths, worktreeBranch, worktreeSystemPrompt } from "./worktree.js";
import { AG2_REASK_TEXT, checkProof, newUntracked, parseWorkerReport, untrackedPaths, type BashRun } from "./report.js";
import {
  appendPoolMetric,
  firstRequestShare,
  firstRouterShare,
  pickSlot,
  poolCarry,
  poolMetricsPath,
  poolStatePath,
  pooledTaskText,
  pooledUnitPrompt,
  splitSharedSpec,
  poolIneligibleReason,
  poolPort,
  recentWarmKeys,
  spareKey,
  spareShouldRetire,
  poolSettings,
  type PoolSettings,
  readPoolMetrics,
  slotKey,
  slotShouldReap,
  warmOrCold,
  writePoolState,
  writeReloadMarker,
  clearReloadMarker,
  poolHostStale,
  credentialChangeStamp,
  looksLikeAuthFailure,
  type PoolSlotRecord,
  type PoolSpareRecord,
  type PoolState,
  type SpareMissReason,
  type WarmKey,
  type PoolTaskRequest,
  type PoolTaskResponse,
  type SlotProcess,
  type SlotSpawner,
} from "./pool.js";
import { usageLogFile } from "../router/usage.js";
import { reapNewSince, snapshotWorkerPids } from "./reap.js";
import { LOOPBACK_HOST, loopbackUrl } from "../utils/loopback.js";

// ---------------------------------------------------------------------------
// Slot process (real spawn)
// ---------------------------------------------------------------------------

/** The production spawner: one `claude` stream-json process per slot. */
export const realSpawner: SlotSpawner = (argv, cwd, env) => {
  const proc = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  const slot: SlotProcess = {
    pid: proc.pid ?? -1,
    write(line: string): boolean {
      try {
        return proc.stdin!.write(line + "\n");
      } catch {
        return false;
      }
    },
    kill(signal = "SIGTERM"): boolean {
      try {
        proc.kill(signal);
        return true;
      } catch {
        return false;
      }
    },
    onLine(cb) {
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", cb);
    },
    onExit(cb) {
      proc.on("close", (code) => cb(code));
      proc.on("error", () => cb(-1));
    },
  };
  return slot;
};

// ---------------------------------------------------------------------------
// Slot session — one long-lived claude, tasks fed as user turns
// ---------------------------------------------------------------------------

/**
 * A live slot: the process plus an event demux. Every stream-json line is
 * parsed and handed to the registered listeners; a task feed registers one
 * for its turn and removes it at the result. Slots are exclusive — a task
 * is fed only while no other feed is waiting.
 */
export class PoolSlotSession {
  readonly record: PoolSlotRecord;
  /** The spec's shared preamble this process carries in its system prompt (null = none). */
  shared: string | null = null;
  /** Stable PAI_POOL_SLOT name of this process. */
  slotName = "";
  private proc: SlotProcess;
  private listeners = new Set<(e: StreamEvent) => void>();
  private exited = false;
  private exitCode: number | null = null;
  private exitWaiters: Array<(code: number | null) => void> = [];
  private feeding = false;

  constructor(record: PoolSlotRecord, proc: SlotProcess) {
    this.record = record;
    this.proc = proc;
    proc.onLine((line) => this.onLine(line));
    proc.onExit((code) => {
      this.exited = true;
      this.exitCode = code;
      for (const w of this.exitWaiters.splice(0)) w(code);
      for (const l of [...this.listeners]) l({ type: "slot-exit" });
    });
  }

  get pid(): number {
    return this.record.pid;
  }

  get busy(): boolean {
    return this.feeding;
  }

  get dead(): boolean {
    return this.exited;
  }

  private onLine(line: string): void {
    if (!line.startsWith("{")) return;
    let e: StreamEvent;
    try {
      e = JSON.parse(line) as StreamEvent;
    } catch {
      return;
    }
    for (const l of [...this.listeners]) l(e);
  }

  /**
   * Feed one user turn and resolve with its result event — or null when the
   * slot exits first (crash, kill, deadline). `onEvent` sees every stream
   * event of the turn as it arrives, so the caller mirrors and live-updates.
   */
  async feed(text: string, onEvent: (e: StreamEvent) => void): Promise<StreamEvent | null> {
    if (this.exited || this.feeding) return null;
    this.feeding = true;
    let result: StreamEvent | null = null;
    let resolveFeed: (() => void) | null = null;
    const done = new Promise<StreamEvent | null>((resolve) => {
      resolveFeed = () => resolve(result);
    });
    const listener = (e: StreamEvent): void => {
      if (e.type === "slot-exit") {
        if (resolveFeed) {
          const r = resolveFeed;
          resolveFeed = null;
          r();
        }
        return;
      }
      onEvent(e);
      if (e.type === "result" && resolveFeed) {
        result = e;
        const r = resolveFeed;
        resolveFeed = null;
        r();
      }
    };
    this.listeners.add(listener);
    if (!this.proc.write(stdinUserMessage(text))) {
      this.listeners.delete(listener);
      this.feeding = false;
      return null;
    }
    try {
      return await done;
    } finally {
      this.listeners.delete(listener);
      this.feeding = false;
    }
  }

  /** Resolves when the process exits (immediately when it already has). */
  waitExit(): Promise<number | null> {
    if (this.exited) return Promise.resolve(this.exitCode);
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  /**
   * Resolves on the slot's init event (or its exit, or the timeout). The
   * init carries the claude session id — what `pai worker resume` and the
   * cockpit's session map key on.
   */
  waitInit(timeoutMs: number): Promise<StreamEvent | null> {
    if (this.exited) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = setTimeout(done, timeoutMs);
      const listener = (e: StreamEvent): void => {
        if (e.type === "system" && e.subtype === "init") {
          this.listeners.delete(listener);
          done(e);
        } else if (e.type === "slot-exit") {
          done(null);
        }
      };
      function done(e?: StreamEvent | null): void {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
        resolve(e ?? null);
      }
      this.listeners.add(listener);
    });
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): void {
    try {
      this.proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export interface PoolHostOptions {
  config?: WorkersConfig;
  logDir?: string;
  /** Router usage log read for the local-model first-request share; defaults to the live log. */
  usageLogFile?: string;
  port?: number;
  spawner?: SlotSpawner;
  /** Test hooks: the env/argv builders, so tests can run a fake claude. */
  /** `routerOn` is the per-provider router choice (loopback providers follow the router probe). */
  envFor?: (providerName: string, provider: WorkerProvider, routerOn?: boolean) => NodeJS.ProcessEnv;
  /** Router liveness probe for loopback providers; defaults to the real one. */
  probeRouter?: () => Promise<boolean>;
  cmdHead?: (env: NodeJS.ProcessEnv) => string[];
  /**
   * Route slot traffic through the local model router when it is enabled
   * (the default resolves it from the daemon config): the router resolves
   * the slot's model to the provider, injects the key, and logs usage+cache
   * per session — without it, pooled traffic bypasses the router's usage
   * log entirely and the cockpit's hit ratios fly blind for pooled sessions.
   */
  routerEnabled?: boolean;
  now?: () => Date;
  /** Disable the idle reaper interval (tests drive reapSlots directly). */
  noReaper?: boolean;
  /** (provider, model, cwd) triples to start spares for at boot; defaults to the workers of the last 60 min in the ledger. */
  warmKeys?: WarmKey[];
  /**
   * Provider names whose spares are also seeded for every repo in the warm keys, with no ledger history
   * needed. Defaults to the active local provider and the policy's default route; tests inject.
   */
  seedProviders?: () => Promise<string[]>;
  /** The host's own bundle file; when it gets newer on disk the host reloads itself once idle. Unset = never. */
  bundlePath?: string;
  /** mtime (ms) of a file, null when unreadable; tests inject. */
  fileMtime?: (path: string) => number | null;
  /**
   * Start the replacement host (production: spawn the same argv detached) and resolve true once it answers
   * /healthz. Called with this host's listener already closed; false/reject = the replacement did not come up.
   */
  reexec?: () => Promise<boolean>;
  /** Config re-read hooks (tests): a stamp that changes when the config was saved, and the loader. Default: the config files' mtimes and readWorkersSection. */
  configStamp?: () => string;
  readConfig?: () => WorkersConfig;
  /** The bundle must have kept the same mtime this long before a reload starts (a build still rewriting it defers). Default 5000. */
  bundleStableMs?: number;
  /** Called after the replacement answered; production exits the process. */
  onReloaded?: () => void;
  /**
   * The login credential's change stamp (keychain mdat + ~/.claude/.credentials.json mtime),
   * null when there is none to watch. Tests inject; production: credentialChangeStamp().
   */
  credStamp?: () => string | null;
  /** Seconds between credential checks (settings.credWatchSec when unset); 0 = off. */
  credWatchSec?: number;
  /**
   * Start a task on a fresh non-pooled worker (the client's fresh-spawn path).
   * Called when a spare's task fails with an auth error: the spare is retired
   * and the task retried once outside the pool. Unset = no retry (the failed
   * answer stands; the client's own fallback still applies).
   */
  retryFresh?: (task: PoolTaskRequest) => Promise<PoolTaskResponse>;
}

export interface PoolHost {
  server: Server;
  port: number;
  logDir: string;
  state(): PoolState;
  /** The listen succeeded: from now on this process owns the port, so it records its pid and start in the state file. */
  listening(): void;
  /** Run one task through the pool; the /task route body. */
  runTask(task: PoolTaskRequest, clientGone?: AbortSignal): Promise<PoolTaskResponse>;
  /** Kill every slot, write final state, close the server. */
  shutdown(): Promise<void>;
  reapSlots(): number;
  /** The pool settings in force now (re-read when the config file changes). */
  settings(): PoolSettings;
  /** Whether the workers config in force offers this provider's model (follows the config reload). */
  offersModel(providerName: string, model: string): boolean;
  /** Re-read the pool settings and the workers config when the config files changed since the last read; true when they did. Checked at most every 5 s unless `force`. */
  reloadSettings(force?: boolean): boolean;
  /** Retire spares idle past workers.pool.idleKillSec. */
  reapSpares(): number;
  /** Move idle spares whose repo HEAD moved onto the new HEAD (git reset in their worktree, no new process). */
  refreshSpares(): number;
  /** Reload onto a newer bundle when one is on disk and no slot is busy; true when it did. */
  checkReload(): Promise<boolean>;
  /**
   * Retire idle spares and mark busy ones for retirement after their task.
   * Runs on the credential watch when the login credential changed; tests drive it directly.
   */
  retireSpares(why: string): number;
  /** Compare the login credential stamp with the last one seen; a change retires the spares. True when it did. */
  checkCredentials(): boolean;
  /** Resolves when every spare start in flight has finished (tests). */
  settle(): Promise<void>;
}

/** Last ~400 KB of the router usage log as lines (a task's rows are at the end), empty on any error. */
function routerUsageTail(file: string): string[] {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 400_000);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** JSON body of a request, capped (task payloads carry a whole spec). */
function readBody(req: IncomingMessage, max = 8 * 1024 * 1024): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  } catch {
    /* client gone */
  }
}

export function createPoolHost(opts: PoolHostOptions = {}): PoolHost {
  const { workers: startupConfig } = opts.config ? { workers: opts.config } : readWorkersSection();
  const logDir = opts.logDir ?? workersLogDir(startupConfig);
  let settings = poolSettings(startupConfig);
  // the workers config follows the settings reload: a provider added later is
  // seen by offersModel/spareCapable without a restart
  let config = startupConfig;
  // opts.config pins the settings (tests, embedding); otherwise a saved config reaches the running host
  const configStamp = opts.configStamp ?? (opts.config ? null : () => workersConfigStamp());
  const readConfig = opts.readConfig ?? (() => readWorkersSection(undefined, () => {}).workers);
  let seenStamp = configStamp ? configStamp() : "";
  let lastStampCheck = 0;
  const reloadSettings = (force = false): boolean => {
    if (!configStamp) return false;
    const t = now().getTime();
    if (!force && t - lastStampCheck < 5000) return false;
    lastStampCheck = t;
    const stamp = configStamp();
    if (stamp === seenStamp) return false;
    seenStamp = stamp;
    try {
      const next = readConfig();
      // running slots are never touched: a lower maxSlots only stops new spawns (pickSlot evicts idle ones when a task needs room)
      settings = poolSettings(next);
      config = next;
      retireHeldSpares();
      return true;
    } catch {
      return false; // a half-written file: keep the settings in force, retry on the next change
    }
  };
  const port = opts.port ?? poolPort(config);
  const spawner = opts.spawner ?? realSpawner;
  // one router decision for both builders: the env carries the router route,
  // the argv pins it again via --settings (the user settings' env outranks
  // the process env — see pinnedSettingsArgs)
  const routerOn = opts.routerEnabled ?? loadConfig().router.enabled;
  const envFor = opts.envFor ?? ((name: string, p: WorkerProvider, via?: boolean) => buildRunEnv(p, true, undefined, name, via ?? routerOn));
  const cmdHead = opts.cmdHead ?? ((env: NodeJS.ProcessEnv) => claudeCommand(env, routerOn));
  const now = opts.now ?? (() => new Date());
  const ledger = ledgerPath(logDir);
  mkdirSync(logDir, { recursive: true });

  const slots = new Map<string, PoolSlotSession>();
  /** Spares by spare id: pre-started task-less workers, one task each; the spareKey groups them for claims. */
  const spares = new Map<string, SpareEntry>();
  const pendingStarts = new Set<Promise<void>>();
  let spareSeq = 0;
  const state: PoolState = {
    hostPid: process.pid,
    port,
    startedAt: nowStamp(now()),
    updatedAt: nowStamp(now()),
    slots: [],
    tasksServed: 0,
    tokensCarried: 0,
    spares: [],
    spareClaims: 0,
    spareMisses: {},
  };
  const fileMtime = opts.fileMtime ?? ((p: string): number | null => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  });
  const startMtime = opts.bundlePath ? fileMtime(opts.bundlePath) : null;
  if (startMtime !== null) state.bundleMtimeMs = startMtime;

  // the state file names this process as the host: it is written only once the port is owned (see listening())
  let owned = false;
  const persist = (): void => {
    state.updatedAt = nowStamp(now());
    state.slots = [...slots.values()].map((s) => s.record);
    state.spares = [...spares.values()].map((e) => e.rec);
    if (owned) writePoolState(state, poolStatePath(logDir));
  };

  const dropSlot = (key: string, why: string): void => {
    const s = slots.get(key);
    if (!s) return;
    slots.delete(key);
    if (!s.dead) s.kill();
    // the settings file carried the provider token: removed once no live slot of that provider/model remains
    if (![...slots.values()].some((o) => o.record.provider === s.record.provider && o.record.model === s.record.model)) {
      rmSync(join(logDir, `${poolSlotSettingsId(s.record.provider, s.record.model)}.settings.json`), { force: true });
    }
    if (!slots.size) removePinFilesOfProcess();
    persist();
    appendLedger(ledger, "WORKER-POOL-SLOT-END", { key: key.replaceAll("\u0000", "/"), pid: s.pid, note: why });
  };

  let plainSlots = 0;
  /** Worktree slots keep their slot dir name (codernext4-1); other slots get a host-unique one. */
  const slotNameFor = (cwd: string): string =>
    dirname(cwd) === slotsDir(logDir) ? basename(cwd) : `pool-${process.pid}-${++plainSlots}`;

  /** Spawn a slot process for provider+model, wait for its init event. */
  const spawnSlot = async (
    providerName: string,
    provider: WorkerProvider,
    model: string,
    cwd: string,
    shared?: string | null,
    mode: "slot" | "spare" = "slot"
  ): Promise<PoolSlotSession | null> => {
    // loopback providers take the router like worker runs do (prefix fixes); down or `router: false` stays direct
    const via = await loopbackRouterChoice(provider, providerName, routerOn, opts.probeRouter ?? probeRouter);
    const env = envFor(providerName, provider, via);
    // no static PAI_WORKER_ID on a slot: it serves many tasks, so a baked-in id
    // would attribute later jobs' children to a stale worker
    delete env.PAI_WORKER_ID;
    // ...but it does have a stable name; the job it serves is in slots/<name>.current (worker-id.ts)
    const slotName = slotNameFor(cwd);
    env[POOL_SLOT_ENV] = slotName;
    let cmd: string[] = [...cmdHead(env)];
    const addendum = loadContractAddendum(providerName, provider.contract);
    cmd.push("--model", model);
    cmd.push("--strict-mcp-config", "--mcp-config", ensureNoMcpConfig(logDir));
    cmd.push(...headlessToolGrants([]));
    // a slot is born like a bare headless worker: the default core grant,
    // narrowed schemas (headlessToolsFlag([]) names none) included
    cmd.push(...(headlessToolsFlag([]).length ? headlessToolsFlag([]) : ["--tools", DEFAULT_WORKER_TOOLS]));
    const slim = slimProfileArgs(logDir, poolSlotSettingsId(providerName, model), [], env, undefined, provider, pinnedSettings(env, routerOn, claudeSettingsExtra(env)));
    cmd.push(...slim);
    cmd.push("--output-format", "stream-json", "--verbose", "--input-format", "stream-json");
    // stream-json input is a print-mode feature: without -p the CLI would
    // start the interactive REPL over the pipes and never speak stream-json
    cmd.push("-p");
    cmd.push(
      ...appendSystemPromptArgs([
        mode === "spare"
          ? "You are a worker that was started ahead of time: your first user message is your one task. " +
            "Answer only from that task's spec."
          : "You are a pooled worker session: each user turn is a NEW, unrelated task introduced by a " +
            "system-reminder boundary line. Never carry context between tasks; answer each task only " +
            "from its own spec.",
        mode === "spare"
          ? `Working directory: ${cwd} (a git worktree; the task names your worker id and branch).`
          : `Working directory: ${cwd} (fixed for the whole session).`,
        // the provider's contract addendum is part of the stable prefix: for local
        // models it is what keeps their output in contract, and as slot system
        // prompt it is cached with the rest of the prefix instead of per task
        ...(addendum ? [addendum.text] : []),
        ...(slim.length ? [WORKER_BRIEF] : []),
        // the spec's marked shared preamble: inside the cached prefix, not in the user turn
        ...(shared ? [shared] : []),
      ])
    );
    cmd = ensureToolSearch(cmd);

    const record: PoolSlotRecord = {
      provider: providerName,
      model,
      cwd,
      pid: -1,
      claudeSession: null,
      spawnedAt: nowStamp(now()),
      lastUsedAt: nowStamp(now()),
      tasks: 0,
      busyWith: null,
    };
    const proc = spawner(cmd, cwd, env);
    record.pid = proc.pid;
    const session = new PoolSlotSession(record, proc);
    session.slotName = slotName;
    session.shared = shared ?? null;

    // the init event announces the session id — when the build emits it at
    // startup. Some builds only speak with the first turn, so a timeout is
    // not fatal: the slot registers anyway and the late listener fills the
    // session id in (only a DEAD process refuses the slot — the client then
    // falls back to a fresh spawn)
    const init = await session.waitInit(8_000);
    if (init) {
      record.claudeSession = init.session_id ?? null;
      const cw = initContextWindow(init);
      if (cw) record.contextWindow = cw;
    }
    if (session.dead) {
      if (!session.dead) session.kill();
      return null;
    }
    if (!record.claudeSession) {
      void session.waitInit(10 * 60_000).then((late) => {
        if (late?.session_id) {
          record.claudeSession = late.session_id;
          const cw = initContextWindow(late);
          if (cw) record.contextWindow = cw;
          persist();
          appendLedger(ledger, "WORKER-POOL-SLOT", {
            provider: providerName,
            model,
            pid: session.pid,
            session: record.claudeSession,
            cwd,
            note: "init arrived with the first task",
          });
        }
      });
    }
    if (mode === "spare") return session;
    slots.set(slotKey(providerName, model, cwd), session);
    appendLedger(ledger, "WORKER-POOL-SLOT", {
      provider: providerName,
      model,
      pid: session.pid,
      session: record.claudeSession,
      cwd,
    });
    persist();
    return session;
  };

  const acquire = async (
    providerName: string,
    provider: WorkerProvider,
    model: string,
    cwd: string,
    shared?: string | null
  ): Promise<PoolSlotSession | null> => {
    const key = slotKey(providerName, model, cwd);
    reloadSettings();
    reapSlots();
    const pick = pickSlot(
      [...slots.values()].map((s) => s.record),
      key,
      settings.maxSlots,
      now().getTime(),
      settings.idleSecs
    );
    if (pick.slot) {
      const s = slots.get(slotKey(pick.slot.provider, pick.slot.model, pick.slot.cwd));
      if (s && !s.busy && !s.dead) return s;
    }
    if (pick.evict) {
      dropSlot(slotKey(pick.evict.provider, pick.evict.model, pick.evict.cwd), "evicted for new slot");
    }
    if (pick.canSpawn) return spawnSlot(providerName, provider, model, cwd, shared);
    return null; // pool at capacity: the client falls back to a fresh spawn
  };

  /** Slot keys being claimed right now (the spawn awaits, so a second task must not take the same one). */
  const claimed = new Set<string>();

  /**
   * A slot for a worktree task: the first slot number whose persistent
   * worktree serves the task's repo and is not busy. Each slot number owns one
   * worktree dir (slots.ts), which is the claude process's cwd for its whole
   * life — the system prompt stays byte-identical from task to task.
   * The process ends after each task (fresh conversation); the dir and its cached system prompt persist.
   */
  const acquireSlotWorktree = async (
    providerName: string,
    provider: WorkerProvider,
    model: string,
    repo: string,
    wid: string,
    shared?: string | null
  ): Promise<{ session: PoolSlotSession; n: number; dir: string } | null> => {
    reloadSettings();
    for (let n = 1; n <= settings.maxSlots; n++) {
      if (!slotServesRepo(logDir, providerName, n, repo)) continue;
      const dir = slotPath(logDir, providerName, n);
      const key = slotKey(providerName, model, dir);
      const ex = slots.get(key);
      if (claimed.has(key) || (ex && (ex.busy || ex.record.busyWith))) continue;
      claimed.add(key);
      try {
        ensureSlotWorktree(logDir, providerName, n, repo);
        const session = await acquire(providerName, provider, model, dir, shared);
        if (!session) return null;
        session.record.busyWith = wid;
        return { session, n, dir };
      } catch {
        return null;
      } finally {
        claimed.delete(key);
      }
    }
    return null;
  };

  const release = (session: PoolSlotSession): void => {
    if (session.slotName) clearSlotCurrent(logDir, session.slotName);
    session.record.tasks += 1;
    session.record.lastUsedAt = nowStamp(now());
    session.record.busyWith = null;
    persist();
  };

  const repoRootOf = (cwd: string): string | null => {
    try {
      return git(cwd, ["rev-parse", "--show-toplevel"]);
    } catch {
      return null;
    }
  };

  const discardSpare = (e: SpareEntry, why: string): void => {
    if (!spares.delete(e.rec.id)) return;
    if (e.session && !e.session.dead) e.session.kill();
    removeSpareWorktree(e.rec.repo, e.rec.dir, e.rec.branch);
    persist();
    appendLedger(ledger, "WORKER-POOL-SPARE-END", { spare: e.rec.id, provider: e.rec.provider, note: why });
  };

  /**
   * Retire spares: idle ones now, busy ones once their task ends (the task
   * finishes on its way; the entry then goes). Driven by the credential watch
   * when the login changed — a spare holds the credential its process started
   * with, and a re-login does not reach it (2026-10-24: stale spares served
   * every Anthropic task with "Failed to authenticate").
   */
  const retireSpares = (why: string): number => {
    let n = 0;
    for (const e of [...spares.values()]) {
      if (e.retiring) continue;
      e.retiring = true;
      if (e.rec.state === "ready" && e.session && !e.session.busy && !e.session.dead) {
        discardSpare(e, why);
        n++;
      } else {
        appendLedger(ledger, "WORKER-POOL-SPARE-RETIRE", { spare: e.rec.id, provider: e.rec.provider, note: why });
      }
    }
    return n;
  };

  /** The distinct repo/provider/model keys the current spares serve (what to top up after a retire). */
  const spareKeysInUse = (): { repo: string; provider: string; model: string }[] => {
    const seen = new Map<string, { repo: string; provider: string; model: string }>();
    for (const e of spares.values()) seen.set(spareKey(e.rec.repo, e.rec.provider, e.rec.model), { repo: e.rec.repo, provider: e.rec.provider, model: e.rec.model });
    return [...seen.values()];
  };

  /** Start one spare: worktree from the repo's HEAD, claude waiting for its first turn. */
  const startSpare = async (repo: string, providerName: string, model: string): Promise<void> => {
    const provider = getProviderOrNative(config, providerName);
    if (!provider) return;
    const sid = `spare-${process.pid}-${++spareSeq}`;
    let wt: { dir: string; branch: string; base: string };
    try {
      wt = addSpareWorktree(logDir, repo, sid);
    } catch (err) {
      appendLedger(ledger, "WORKER-NOTE", { id: sid, note: `spare worktree failed: ${(err as Error).message}` });
      return;
    }
    const rec: PoolSpareRecord = {
      id: sid,
      repo,
      provider: providerName,
      model,
      dir: wt.dir,
      branch: wt.branch,
      base: wt.base,
      pid: -1,
      createdAt: nowStamp(now()),
      state: "starting",
    };
    const entry: SpareEntry = { rec, session: null };
    spares.set(sid, entry);
    persist();
    let session: PoolSlotSession | null = null;
    try {
      session = await spawnSlot(providerName, provider, model, wt.dir, null, "spare");
    } catch (err) {
      appendLedger(ledger, "WORKER-NOTE", { id: sid, note: `spare start failed: ${(err as Error).message}` });
    }
    if (!session) return discardSpare(entry, "spare process did not start");
    entry.session = session;
    rec.pid = session.pid;
    rec.state = "ready";
    persist();
    if (entry.retiring) {
      discardSpare(entry, "login changed while starting");
      return;
    }
    appendLedger(ledger, "WORKER-POOL-SPARE", { spare: sid, provider: providerName, model, pid: session.pid, cwd: wt.dir, base: wt.base.slice(0, 8) });
    void session.waitExit().then(() => {
      if (rec.state === "ready" && spares.get(rec.id) === entry) discardSpare(entry, "spare process exited");
    });
  };

  /** A held provider keeps no idle spares (they would start work on it); claimed and busy ones are untouched. */
  const retireHeldSpares = (): number => {
    let n = 0;
    for (const e of [...spares.values()]) {
      if (!getProviderOrNative(config, e.rec.provider)?.hold) continue;
      if (e.rec.state === "ready" && e.session && !e.session.busy && !e.session.dead) {
        e.retiring = true;
        discardSpare(e, "provider on hold");
        n++;
      }
    }
    return n;
  };

  const spareCapable = (providerName: string): boolean => {
    const p = getProviderOrNative(config, providerName);
    if (!p || (p.engine ?? "claude") !== "claude" || p.hold) return false;
    return !(p.native && !settings.native);
  };

  /** Whether the provider's model table (what the router resolves from) offers this model; native also takes any claude-* id. Follows the config reload — a provider added later is seen without a restart. */
  const offersModel = (providerName: string, model: string): boolean => {
    const p = getProviderOrNative(config, providerName);
    if (!p) return false;
    const bare = stripContextSuffix(model);
    if (p.native && /^claude-/.test(bare)) return true;
    return Object.values(p.models).some((id) => !!id && stripContextSuffix(id) === bare);
  };

  /** Bring a key up to workers.pool.spares in the background (nothing stops a key that has none yet). */
  const topUp = (repo: string, providerName: string, model: string): void => {
    if (getProviderOrNative(config, providerName)?.hold) retireHeldSpares();
    if (settings.spares <= 0 || !spareCapable(providerName)) return;
    const key = spareKey(repo, providerName, model);
    const have = [...spares.values()].filter((e) => !e.retiring && spareKey(e.rec.repo, e.rec.provider, e.rec.model) === key).length;
    for (let i = have; i < settings.spares; i++) {
      const p: Promise<void> = startSpare(repo, providerName, model)
        .catch(() => undefined)
        .finally(() => pendingStarts.delete(p));
      pendingStarts.add(p);
    }
  };

  /** Move an idle spare's worktree onto the repo's new HEAD; its claude process is waiting for a first turn and does not care. */
  const refreshSpare = (e: SpareEntry, head: string): boolean => {
    try {
      git(e.rec.dir, ["reset", "--hard", "-q", head]);
    } catch {
      return false;
    }
    e.rec.base = head;
    persist();
    appendLedger(ledger, "WORKER-POOL-SPARE-REFRESH", { spare: e.rec.id, provider: e.rec.provider, base: head.slice(0, 8) });
    return true;
  };

  const refreshSpares = (): number => {
    let n = 0;
    for (const e of [...spares.values()]) {
      if (e.rec.state !== "ready" || !e.session || e.session.dead || e.session.busy) continue;
      let head = "";
      try {
        head = git(e.rec.repo, ["rev-parse", "HEAD"]);
      } catch {
        continue;
      }
      if (head === e.rec.base) continue;
      if (refreshSpare(e, head)) n++;
      else {
        discardSpare(e, "stale: refresh failed");
        topUp(e.rec.repo, e.rec.provider, e.rec.model);
      }
    }
    return n;
  };

  const missSpare = (task: PoolTaskRequest, reason: SpareMissReason): PoolTaskResponse => {
    state.spareMisses![reason] = (state.spareMisses![reason] ?? 0) + 1;
    appendLedger(ledger, "WORKER-POOL-MISS", { id: task.id, provider: task.provider, reason });
    persist();
    return { pooled: false, reason };
  };

  /** Take a ready spare for the task, bound to its branch name, or say why none. */
  const claimSpare = (task: PoolTaskRequest): { entry: SpareEntry } | { reason: SpareMissReason } => {
    if (settings.spares <= 0) return { reason: "spares-off" };
    if (!task.worktree) return { reason: "no-worktree" };
    const repo = repoRootOf(task.cwd);
    if (!repo) return { reason: "not-git" };
    const key = spareKey(repo, task.provider, task.model);
    const list = [...spares.values()].filter((e) => spareKey(e.rec.repo, e.rec.provider, e.rec.model) === key);
    const ready = list.find((e) => e.rec.state === "ready" && !e.retiring && e.session && !e.session.dead && !e.session.busy);
    if (!ready) {
      topUp(repo, task.provider, task.model); // the next run of this key finds one
      return { reason: list.length ? "starting" : "no-spare" };
    }
    // a spare is cut from the HEAD of its day: a moved HEAD or a dirty checkout is not what a fresh worker would see
    let head = "";
    try {
      head = git(repo, ["rev-parse", "HEAD"]);
    } catch {
      return { reason: "not-git" };
    }
    if (head !== ready.rec.base && !refreshSpare(ready, head)) {
      discardSpare(ready, "stale: repo HEAD moved");
      topUp(repo, task.provider, task.model);
      return { reason: "stale" };
    }
    try {
      // the spare stays: a fresh worker for this run, the spare still serves the next clean one
      if (uncommittedPaths(repo).some((p) => !isPaiBookkeepingPath(p))) return { reason: "dirty-checkout" };
    } catch {
      return { reason: "not-git" };
    }
    try {
      git(ready.rec.dir, ["branch", "-m", ready.rec.branch, worktreeBranch(task.id)]);
    } catch {
      discardSpare(ready, "branch rename failed");
      return { reason: "rename-failed" };
    }
    ready.rec.branch = worktreeBranch(task.id);
    spares.delete(ready.rec.id);
    return { entry: ready };
  };

  /** One pooled task, end to end. */
  /** Tasks being served right now, spare-served ones included (they hold no slot): a reload waits for them. */
  let inflight = 0;
  /** Running tasks by worker id: aborting one ends its slot process through the client-gone path (`POST /task/<id>/stop`). */
  const stoppers = new Map<string, AbortController>();
  const runTask = async (task: PoolTaskRequest, clientGone?: AbortSignal): Promise<PoolTaskResponse> => {
    inflight++;
    const stop = new AbortController();
    clientGone?.addEventListener("abort", () => stop.abort(), { once: true });
    if (clientGone?.aborted) stop.abort();
    if (task.id) stoppers.set(task.id, stop);
    try {
      return await runTaskInner(task, stop.signal);
    } finally {
      if (task.id && stoppers.get(task.id) === stop) stoppers.delete(task.id);
      inflight--;
    }
  };
  const runTaskInner = async (task: PoolTaskRequest, clientGone?: AbortSignal): Promise<PoolTaskResponse> => {
    if (drainSince !== null) return { pooled: false, reason: "busy" };
    const provider = getProviderOrNative(config, task.provider);
    if (!provider) return { pooled: false, reason: "engine" };
    // the client screens eligibility before shipping the task; the host
    // re-checks so a stale client cannot push an incompatible task into a
    // warm slot
    const inelig = poolIneligibleReason({
      headless: true,
      prompt: task.prompt,
      providerName: task.provider,
      provider,
      nativeAllowed: settings.native,
      worktreeWanted: task.worktree === true,
      slotWorktree: isLoopbackProvider(provider) || task.spare === true,
      resumeOf: undefined,
      printCmd: false,
      parsed: { callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: [] },
      mcpFlag: undefined,
      noBrowser: true,
      outputFormat: task.outputFormat,
      cwd: task.cwd,
    });
    if (inelig) return { pooled: false, reason: inelig };

    const wid = task.id;
    const claimT0 = Date.now();
    // a worktree task runs in the slot's own worktree on a fresh branch; every
    // other task runs in the cwd it came with
    let prep: SlotPrep | null = null;
    let session: PoolSlotSession | null;
    const split = splitSharedSpec(task.prompt);
    let spareEntry: SpareEntry | null = null;
    if (task.spare) {
      const got = claimSpare(task);
      if ("reason" in got) return missSpare(task, got.reason);
      spareEntry = got.entry;
      session = got.entry.session!;
      prep = { dir: got.entry.rec.dir, branch: got.entry.rec.branch, base: got.entry.rec.base, snapshot: false, salvagePatch: null };
      session.record.branch = prep.branch;
      state.spareClaims = (state.spareClaims ?? 0) + 1;
    } else if (task.worktree) {
      // worktree tasks get a fresh process, so the spec's shared block can ride in its system prompt
      const got = await acquireSlotWorktree(task.provider, provider, task.model, task.cwd, wid, split.shared);
      session = got?.session ?? null;
      if (got && session) {
        try {
          prep = prepareSlot(logDir, task.provider, got.n, task.cwd, wid);
        } catch (e) {
          session.record.busyWith = null;
          persist();
          appendLedger(ledger, "WORKER-NOTE", { id: wid, note: `slot prepare failed: ${(e as Error).message}` });
          return { pooled: false, reason: "host-error" };
        }
        session.record.branch = prep.branch;
        if (prep.salvagePatch) appendLedger(ledger, "WORKER-NOTE", { id: wid, note: `slot was dirty: diff saved to ${prep.salvagePatch}` });
      }
    } else {
      session = await acquire(task.provider, provider, task.model, task.cwd);
    }
    if (!session) return { pooled: false, reason: "busy" };
    const spareKeyOf = spareEntry ? spareKey(spareEntry.rec.repo, task.provider, task.model) : null;
    const workDir = prep?.dir ?? task.cwd;

    const taskNo = session.record.tasks + 1;
    session.record.busyWith = wid;
    persist();

    // The client passed the gates under this id before shipping the task; its
    // placeholder status rewrote `started` when the capacity slot was granted.
    // Keep that stamp — the deadline counts from the slot grant, not from the
    // host's pickup.
    const prior = loadStatus(logDir, wid);
    const priorStart = prior ? Date.parse(prior.started.replace(" ", "T")) : NaN;
    const started = Number.isFinite(priorStart) ? new Date(priorStart) : now();
    const t0 = started.getTime();
    const status: WorkerStatus = {
      id: wid,
      pid: session.pid,
      label: task.label,
      cwd: task.cwd,
      term: "",
      provider: task.provider,
      model: task.model,
      state: "running",
      started: nowStamp(started),
      updated: nowStamp(started),
      turns: 0,
      tools: 0,
      last: "starting (pooled)",
      rc: null,
      secs: null,
      origin: "spawn",
      outputFormat: task.outputFormat,
      ...(task.maxMinutes ? { deadlineAt: t0 + task.maxMinutes * 60_000, maxMinutes: task.maxMinutes } : {}),
      ...(task.parent ? { parent: task.parent } : {}),
      ...(task.stage ? { stage: task.stage } : {}),
      pool: {
        task: taskNo,
        slotSession: session.record.claudeSession,
        hostPid: process.pid,
        ...(task.clientPid ? { clientPid: task.clientPid } : {}),
        ...(prep ? { slot: prep.dir } : {}),
        ...(spareEntry ? { spare: true } : {}),
      },
      ...(prep ? { branch: prep.branch, worktreeDir: prep.dir, worktreeBase: prep.base, worktreeSnapshot: false } : {}),
    };
    // a spare announced its session before it had a task: the init event is already behind us
    if (spareEntry && session.record.claudeSession) {
      status.claudeSession = session.record.claudeSession;
      if (session.record.contextWindow) status.contextWindow = session.record.contextWindow;
    }
    saveStatus(logDir, status);
    if (session.slotName) setSlotCurrent(logDir, session.slotName, wid);
    // setup: run start -> the worker process holds the task as its first turn
    const readyAt = Date.now();
    const setupMs = task.runStartedAt ? Math.max(0, readyAt - task.runStartedAt) : undefined;
    const claimMs = spareEntry ? readyAt - claimT0 : undefined;
    const timing: { firstAt: number | null } = { firstAt: null };
    appendLedger(ledger, "WORKER-START", {
      id: wid,
      provider: task.provider,
      mode: spareEntry ? "headless" : "pooled",
      ...(spareEntry ? { spare: "hit" } : {}),
      ...(setupMs !== undefined ? { setupMs } : {}),
      ...(task.admissionMs !== undefined ? { admissionMs: task.admissionMs } : {}),
      ...(claimMs !== undefined ? { claimMs } : {}),
      model: task.model,
      cwd: task.cwd,
      label: task.label,
      poolTask: taskNo,
      ...(task.capability ? { capability: task.capability } : {}),
      ...(task.specPath ? { spec: task.specPath } : {}),
    });

    const eventsFd = openSync(eventsPath(logDir, wid), "a");
    const writeEvent = (obj: Record<string, unknown>): void => {
      try {
        writeSync(eventsFd, JSON.stringify({ ...obj, _ts: isoStamp(now()) }) + "\n");
      } catch {
        /* a full disk must not take the pool host down */
      }
    };
    writeEvent({ type: "pooled-task", task: taskNo, slot: session.record.claudeSession, cwd: workDir, ...(prep ? { branch: prep.branch } : {}) });

    let deadlineFired = false;
    const deadTimer =
      task.maxMinutes && task.maxMinutes > 0
        ? setTimeout(() => {
            deadlineFired = true;
            status.timedOut = true;
            appendLedger(ledger, "WORKER-DEADLINE", { id: wid, minutes: task.maxMinutes });
            saveStatus(logDir, status);
            session.kill("SIGTERM");
          }, task.maxMinutes * 60_000)
        : null;

    // the client hung up before the answer was written: nobody wants this
    // result, so cancel through the same kill the deadline uses
    let clientGoneFired = false;
    const onClientGone = (): void => {
      clientGoneFired = true;
      appendLedger(ledger, "WORKER-CLIENT-GONE", { id: wid });
      session.kill("SIGTERM");
    };
    if (clientGone?.aborted) onClientGone();
    else clientGone?.addEventListener("abort", onClientGone, { once: true });

    // per-task scratch: the first request's usage (the carry metric), the
    // tool table for Bash-proof accounting, and the untracked baseline
    // (holder object: a plain `let` would be flow-narrowed to null at the
    // use site below, since only the callback ever assigns it)
    const scratch: { firstUsage: UsageBlock | null } = { firstUsage: null };
    const toolUses = new Map<string, { name: string; input: unknown }>();
    const bashRuns: BashRun[] = [];
    const untrackedAtStart = new Set(untrackedPaths(workDir));

    const onEvent = (e: StreamEvent): void => {
      writeEvent(e as Record<string, unknown>);
      if (e.type === "system" && e.subtype === "init") {
        if (e.session_id) status.claudeSession = e.session_id;
        adoptInitModel(status, e);
        const cw = initContextWindow(e);
        if (cw) status.contextWindow = cw;
      } else if (isCompactBoundary(e)) {
        resetContextTokensOnCompact(status, e);
      } else if (e.type === "assistant") {
        status.turns += 1;
        timing.firstAt ??= Date.now();
        bumpContextTokens(status, usageContextUsed(e.message?.usage));
        status.contextUsed = usageContextUsed(e.message?.usage) ?? status.contextUsed;
        if (!scratch.firstUsage && usageContextTokens(e.message?.usage)) scratch.firstUsage = e.message?.usage ?? null;
        for (const block of e.message?.content ?? []) {
          if (block.type === "tool_use") {
            status.tools += 1;
            if (block.id) toolUses.set(block.id, { name: block.name ?? "?", input: block.input });
            status.last = describeTool(block.name ?? "?", block.input);
            if (block.name === "Bash") {
              status.sleepSec = parseSleepSecs(String((block.input as { command?: unknown })?.command ?? ""));
            }
          } else if (block.type === "text" && (block.text ?? "").trim()) {
            status.last = "says: " + String(block.text).slice(0, 70);
          }
        }
      } else if (e.type === "user") {
        const blocks = e.message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block.type !== "tool_result") continue;
            const use = block.tool_use_id ? toolUses.get(block.tool_use_id) : undefined;
            if (use?.name === "Bash") {
              const text = typeof block.content === "string" ? block.content : "";
              const failed = block.is_error === true || /Exit code [1-9]/.test(text);
              bashRuns.push({ command: String((use.input as { command?: unknown })?.command ?? ""), failed, output: text.slice(-400) });
            }
          }
        }
      } else if (e.type === "result") {
        // glm-family endpoints report zeros on every assistant message and
        // the real totals on the result event — use it for the carry metric
        // when no assistant usage carried numbers. The meter is untouched:
        // a result event's usage is the run's cumulative total, never a turn
        // fill (a pooled slot spans tasks, so it would poison every later one).
        const ru = (e as { usage?: UsageBlock }).usage;
        const ruTokens = usageContextTokens(ru);
        if (!scratch.firstUsage && ru && ruTokens !== null && ruTokens > 0) scratch.firstUsage = ru;
        const report = parseWorkerReport(e.result ?? "");
        if (report?.notes) status.last = String(report.notes).slice(0, 90);
        else if (e.result) status.last = String(e.result).slice(0, 90);
      }
      status.updated = nowStamp(now());
      saveStatus(logDir, status);
    };

    // stable bytes first: the per-unit worker id and branch ride after the spec, not ahead of it
    const wtNote = prep ? worktreeSystemPrompt(wid, prep.branch, prep.dir) : "";
    // a shared block only left the user turn when this very process carries it in its system prompt
    const unitSpec = session.shared && split.shared === session.shared ? split.unit : task.prompt;
    // a spare's task is the whole first turn: no boundary, it has no earlier turns to separate from
    const text = spareEntry
      ? `${pooledUnitPrompt(unitSpec, wtNote)}${task.trailer}`
      : pooledTaskText(taskNo, workDir, pooledUnitPrompt(unitSpec, wtNote), task.trailer);
    // the slot process and its earlier children outlive the task; whatever the task started does not
    const reapOpts = { rootPid: session.pid, ...(prep ? { dir: prep.dir } : {}) };
    const beforeTask = snapshotWorkerPids(reapOpts);
    const feeding = session.feed(text, onEvent);
    // the replacement starts once the task is on its way, not when it ends: back-to-back tasks find the next spare ready
    if (spareEntry) topUp(spareEntry.rec.repo, task.provider, task.model);
    let resultEvent = await feeding;
    await reapNewSince(reapOpts, beforeTask, (l) => writeEvent({ type: "reap", note: l }));
    if (deadTimer) clearTimeout(deadTimer);
    clientGone?.removeEventListener("abort", onClientGone);

    // a spare whose task died on the login ("Failed to authenticate", "Not logged in"): its process
    // holds a dead OAuth session. Retire it and every sibling, retry the task once on a fresh spawn.
    if (spareEntry && !clientGoneFired && !deadlineFired && resultEvent?.is_error && looksLikeAuthFailure(resultEvent.result)) {
      closeSync(eventsFd);
      release(session);
      session.kill();
      removeSpareWorktree(spareEntry.rec.repo, spareEntry.rec.dir, spareEntry.rec.branch);
      appendLedger(ledger, "WORKER-POOL-SPARE-END", { spare: spareEntry.rec.id, provider: task.provider, note: `auth failure on ${wid}` });
      appendLedger(ledger, "WORKER-POOL-AUTH-RETRY", {
        id: wid,
        provider: task.provider,
        spare: spareEntry.rec.id,
        note: opts.retryFresh ? "retried once on a fresh spawn" : "spare retired; client falls back to a fresh spawn",
      });
      const keys = spareKeysInUse();
      retireSpares(`auth failure on ${wid}`);
      for (const k of keys) topUp(k.repo, k.provider, k.model);
      topUp(spareEntry.rec.repo, task.provider, task.model);
      persist();
      if (opts.retryFresh) return opts.retryFresh({ ...task, spare: false });
      return { pooled: false, reason: "auth-retry" };
    }

    let rc: number;
    let report = resultEvent ? parseWorkerReport(resultEvent.result ?? "") : null;

    if (!resultEvent) {
      // slot died mid-task (crash, kill, deadline): the task ends here
      rc = deadlineFired ? 143 : 1;
      status.last = deadlineFired ? `deadline reached after ${task.maxMinutes} min` : "pool slot died mid-task";
      writeEvent({ type: "result", is_error: true, result: status.last });
    } else {
      rc = resultEvent.is_error ? 1 : 0;
      if (isEmptyResponse(resultEvent.result, status.tools)) {
        rc = 1;
        status.last = "harness: empty-response (model returned nothing)";
      }
      // AG2 validity + the one bounded re-ask, fed to the same warm slot
      const rep = task.reportFormat === "ag2" && resultEvent.result ? repairAndValidateAg2(resultEvent.result) : null;
      if (rep?.repairs.length) resultEvent = { ...resultEvent, result: rep.text };
      if (rep && !rep.validation.ok) {
        const v = rep.validation;
        status.reportValid = v.ok;
        status.reportErrors = v.errors;
        appendLedger(ledger, "WORKER-REPORT-RETRY", {
          id: wid,
          reason: v.errors.join("; ") || "invalid AG2 message",
        });
        saveStatus(logDir, status);
        const reask = await session.feed(AG2_REASK_TEXT, onEvent);
        if (reask?.result) {
          const v2 = validateAg2(reask.result);
          status.reportValid = v2.ok;
          status.reportErrors = v2.errors;
          if (v2.ok) {
            resultEvent = reask;
            report = parseWorkerReport(reask.result);
            rc = reask.is_error ? 1 : 0;
          }
        }
      } else if (task.reportFormat === "ag2" && resultEvent.result) {
        status.reportValid = true;
        status.reportErrors = [];
      }
    }

    // proof check against THIS task's bash runs and the untracked files it added
    if (resultEvent?.result && task.reportFormat === "ag2") {
      const stray = newUntracked(workDir, untrackedAtStart);
      const chk = checkProof(resultEvent.result, bashRuns, stray);
      if (chk.rewritten || stray.length) {
        resultEvent = { ...resultEvent, result: chk.text };
        report = parseWorkerReport(chk.text);
        if (chk.rewritten) {
          status.reportValid = false;
          status.last = `claimed proof not run or failed: ${chk.proof}`;
          appendLedger(ledger, "REPORT-PROOF-UNVERIFIED", { id: wid, proof: chk.proof ?? "?" });
        }
      }
    }

    // the loop guard killed the slot: end with the loop-stop report, as a fresh run does
    const loopStop = takeLoopStop(logDir, wid);
    if (loopStop) {
      report = applyLoopStop(status, loopStop, report, resultEvent?.result, prep ? { dir: prep.dir, base: prep.base } : null);
      status.endReason = "loop-stopped";
      rc = rc || 1;
    }
    // the slot moves on to its next task: commit what this one left, carry its
    // Notes/ into the repo, and put the slot on a detached HEAD so the branch
    // is free for `pai worker merge`
    if (prep) {
      try {
        salvageOnExit(ledger, wid, task.label, prep.dir);
        for (const l of salvageNotes(task.cwd, prep.dir, wid)) appendLedger(ledger, "WORKER-NOTE", { id: wid, note: l });
        const had = commitsSince(prep.dir, prep.base);
        // a spare's worktree is the worker's own, kept for review and merge like a fresh worker's
        const { commits } = spareEntry ? { commits: had } : releaseSlot(prep.dir, prep.branch, prep.base);
        if (!spareEntry) session.record.branch = null;
        if (spareEntry || commits > 0 || had > 0) status.commits = commits;
        else {
          status.branch = null;
          status.worktreeDir = null;
          status.worktreeBase = null;
          status.worktreeSnapshot = null;
          status.commits = null;
        }
      } catch (e) {
        appendLedger(ledger, "WORKER-NOTE", { id: wid, note: `slot release failed: ${(e as Error).message}` });
      }
    }

    if (clientGoneFired) {
      rc = rc || 143;
      status.last = "client gone: task cancelled";
      status.endReason = "client-gone";
    }
    const secs = Math.floor((now().getTime() - t0) / 1000);
    const empty = resultEvent !== null && isEmptyResponse(resultEvent.result, status.tools);
    const ok = !status.timedOut && !clientGoneFired && !loopStop && rc === 0 && !empty;
    status.state = ok ? "done" : "failed";
    status.rc = rc;
    status.secs = secs;
    if (status.timedOut) status.endReason = "deadline";
    saveStatus(logDir, status);
    appendLedger(ledger, "WORKER-END", {
      id: wid,
      provider: task.provider,
      mode: "pooled",
      model: task.model,
      rc,
      secs,
      turns: status.turns,
      tools: status.tools,
      label: task.label,
      poolTask: taskNo,
      ...(spareEntry ? { spare: "hit" } : {}),
      ...(setupMs !== undefined ? { setupMs } : {}),
      ...(task.admissionMs !== undefined ? { admissionMs: task.admissionMs } : {}),
      ...(claimMs !== undefined ? { claimMs } : {}),
      ...(timing.firstAt !== null ? { firstAnswerMs: timing.firstAt - readyAt } : {}),
      ...(status.timedOut ? { timedOut: 1 } : {}),
    });
    closeSync(eventsFd);

    // cache-carry metric: the FIRST assistant usage of the task's turn
    if (scratch.firstUsage) {
      const fu = scratch.firstUsage;
      let share = firstRequestShare(fu);
      // a local model reports no cache tokens: take the share from the router row's time to first token
      if (!share && isLoopbackProvider(provider) && session.record.claudeSession) {
        share = firstRouterShare(routerUsageTail(opts.usageLogFile ?? usageLogFile()), session.record.claudeSession) ?? share;
      }
      appendPoolMetric(
        {
          ts: new Date().toISOString(),
          id: wid,
          provider: task.provider,
          model: task.model,
          task: taskNo,
          slotSession: session.record.claudeSession,
          input_tokens: fu.input_tokens ?? 0,
          output_tokens: fu.output_tokens ?? 0,
          cache_creation_input_tokens: fu.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: fu.cache_read_input_tokens ?? 0,
          ...(isLoopbackProvider(provider) && share !== null ? { firstShare: Math.round(share * 1000) / 1000 } : {}),
        },
        poolMetricsPath(logDir)
      );
      state.tokensCarried += fu.cache_read_input_tokens ?? 0;
      session.record.firstShare = share;
      const wc = warmOrCold(share);
      if (status.pool && share !== null && wc) {
        status.pool.firstShare = Math.round(share * 1000) / 1000;
        status.pool.warm = wc;
        saveStatus(logDir, status);
      }
    }
    state.tasksServed += 1;
    release(session);
    if (spareEntry && spareKeyOf) {
      // one task per spare: the process ends, the worktree stays (its replacement started at the claim)
      session.kill();
      appendLedger(ledger, "WORKER-POOL-SPARE-END", { spare: spareEntry.rec.id, provider: task.provider, note: `served ${wid}` });
    } else if (session.dead) dropSlot(slotKey(task.provider, task.model, workDir), "slot exited after task");
    // a worktree task gets a fresh conversation: the process ends, the next task spawns a new one in the same slot dir
    else if (prep) dropSlot(slotKey(task.provider, task.model, workDir), "fresh conversation per worktree task");

    return { pooled: true, rc, resultEvent, report, status };
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", loopbackUrl(0));
    if (refuseUnlessLoopback(req, res, { requireJson: url.pathname !== "/shutdown" })) return;
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain", "x-pool-host-pid": String(process.pid) });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      persist();
      sendJson(res, 200, { ...state, carry: poolCarry(readPoolMetrics(poolMetricsPath(logDir))) });
      return;
    }
    const stopRoute = req.method === "POST" ? /^\/task\/([^/]+)\/stop$/.exec(url.pathname) : null;
    if (stopRoute) {
      const stop = stoppers.get(decodeURIComponent(stopRoute[1]!));
      stop?.abort();
      sendJson(res, stop ? 200 : 404, { stopped: !!stop });
      return;
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      sendJson(res, 200, { ok: true });
      void shutdown();
      return;
    }
    if (req.method === "POST" && (url.pathname === "/task" || url.pathname === "/claim")) {
      const claim = url.pathname === "/claim";
      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) gone.abort();
      });
      void readBody(req).then(async (body) => {
        if (!body) return sendJson(res, 400, { pooled: false, reason: "host-error" });
        let task: PoolTaskRequest;
        try {
          task = JSON.parse(body) as PoolTaskRequest;
          if (claim) task.spare = true;
        } catch {
          return sendJson(res, 400, { pooled: false, reason: "host-error" });
        }
        try {
          sendJson(res, 200, await runTask(task, gone.signal));
        } catch (e) {
          sendJson(res, 500, { pooled: false, reason: "host-error", error: (e as Error).message });
        }
      });
      return;
    }
    sendJson(res, 404, { error: `no such route: ${req.method} ${url.pathname}` });
  });

  const shutdown = async (): Promise<void> => {
    for (const [k, s] of slots) {
      s.kill();
      slots.delete(k);
    }
    for (const e of [...spares.values()]) discardSpare(e, "host shutdown");
    persist();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const reapSlots = (): number => {
    reloadSettings();
    let n = 0;
    for (const [k, s] of slots) {
      if (slotShouldReap(s.record, now().getTime(), settings.idleSecs)) {
        dropSlot(k, "idle timeout");
        n++;
      }
    }
    return n;
  };

  const reapSpares = (): number => {
    let n = 0;
    for (const e of [...spares.values()]) {
      if (e.rec.state === "ready" && spareShouldRetire(Date.parse(e.rec.createdAt), now().getTime(), settings.idleKillSec)) {
        discardSpare(e, "idle timeout");
        n++;
      }
    }
    return n;
  };

  let lastCred: string | null | undefined;
  /** One credential check: a changed stamp retires the spares. The first call records the baseline. */
  const checkCredentials = (): boolean => {
    let stamp: string | null;
    try {
      stamp = (opts.credStamp ?? (() => credentialChangeStamp()))();
    } catch {
      return false;
    }
    if (lastCred === undefined) {
      lastCred = stamp;
      return false;
    }
    if (stamp === lastCred) return false;
    lastCred = stamp;
    appendLedger(ledger, "POOL-HOST-CRED-CHANGE", { pid: process.pid, note: "login credential changed: spares retired" });
    const keys = spareKeysInUse();
    retireSpares("login credential changed");
    for (const k of keys) topUp(k.repo, k.provider, k.model);
    return true;
  };

  /** Set when a newer build is waiting on running tasks: no new work is accepted until the restart. */
  let drainSince: number | null = null;
  let reloading = false;
  let seenMtime: number | null = null;
  let seenSince = 0;
  const checkReload = async (): Promise<boolean> => {
    if (reloading || !opts.bundlePath || startMtime === null) return false;
    const disk = fileMtime(opts.bundlePath);
    if (!poolHostStale(startMtime, disk)) return false;
    // a build still rewriting the bundle: wait until its mtime has been stable
    if (disk !== seenMtime) {
      seenMtime = disk;
      seenSince = now().getTime();
    }
    if (now().getTime() - seenSince < (opts.bundleStableMs ?? 5000)) return false;
    // a busy or claimed slot defers the reload until it is idle: drain (hand out nothing new,
    // let running tasks finish) for at most drainTimeoutSec, then go anyway
    if (inflight > 0 || claimed.size || [...slots.values()].some((s) => s.busy || s.record.busyWith)) {
      if (drainSince === null) {
        drainSince = now().getTime();
        appendLedger(ledger, "POOL-HOST-DRAIN", { pid: process.pid, note: "newer build on disk: draining before restart" });
      }
      if (now().getTime() - drainSince < settings.drainTimeoutSec * 1000) return false;
      appendLedger(ledger, "POOL-HOST-DRAIN", { pid: process.pid, note: `drain timeout after ${settings.drainTimeoutSec}s: restarting with tasks running` });
    }
    reloading = true;
    writeReloadMarker(logDir);
    appendLedger(ledger, "POOL-HOST-RELOAD", { pid: process.pid, bundle: opts.bundlePath, note: "newer build on disk" });
    // slots go first (the replacement owns the state file), then the listener is released for it
    for (const [k, s] of slots) {
      s.kill();
      slots.delete(k);
    }
    for (const e of [...spares.values()]) discardSpare(e, "host reload");
    persist();
    server.close();
    server.closeAllConnections?.();
    let up = false;
    let why = "no reexec configured";
    if (opts.reexec) {
      try {
        up = await opts.reexec();
        why = "replacement did not answer /healthz in time";
      } catch (e) {
        why = (e as Error).message;
      }
    }
    if (up) {
      clearReloadMarker(logDir);
      opts.onReloaded?.();
      return true;
    }
    clearReloadMarker(logDir);
    // the replacement is not up: take the port back and keep serving
    await new Promise<void>((resolve) => {
      server.once("error", () => resolve());
      server.listen(port, LOOPBACK_HOST, () => resolve());
    });
    appendLedger(ledger, "POOL-HOST-RELOAD-FAILED", { pid: process.pid, bundle: opts.bundlePath, note: why });
    reloading = false;
    seenMtime = null;
    drainSince = null;
    return false;
  };

  if (!opts.noReaper && opts.bundlePath) {
    const timer = setInterval(() => void checkReload(), 30_000);
    timer.unref?.();
  }
  if (!opts.noReaper && settings.credWatchSec > 0) {
    checkCredentials(); // the baseline
    const timer = setInterval(checkCredentials, (opts.credWatchSec ?? settings.credWatchSec) * 1000);
    timer.unref?.();
  }
  if (!opts.noReaper) {
    const timer = setInterval(() => reloadSettings(), 5_000);
    timer.unref?.();
  }
  // the reaper timers run always: the idle settings can be raised from 0 in the config later (the reapers return at 0)
  if (!opts.noReaper) {
    const timer = setInterval(reapSlots, 30_000);
    timer.unref?.();
  }
  if (!opts.noReaper) {
    const timer = setInterval(() => {
      reapSpares();
      refreshSpares();
    }, 30_000);
    timer.unref?.();
  }

  /** The active local provider (resolved like --local) and the policy's route, when each exists. */
  const defaultSeedProviders = async (): Promise<string[]> => {
    const names = new Set<string>();
    try {
      names.add((await resolveLocalProvider(config, logDir)).name);
    } catch {
      // no local server running
    }
    try {
      const route = await routeRun(config, logDir, {});
      if (route?.providerFlag) names.add(route.providerFlag);
    } catch {
      // policy unreadable or local-only without a server
    }
    return [...names];
  };

  // boot: spares for every key that ran a worker in the last 60 min
  if (settings.spares > 0) {
    let keys = opts.warmKeys;
    if (!keys) {
      try {
        keys = recentWarmKeys(existsSync(ledger) ? readFileSync(ledger, "utf8") : "", now().getTime());
      } catch {
        keys = [];
      }
    }
    // a ledger pair the provider does not offer (e.g. left by an old escalation bug) is not warmed
    keys = keys.filter((k) => offersModel(k.provider, k.model));
    for (const k of keys) {
      const repo = repoRootOf(k.cwd);
      if (repo) topUp(repo, k.provider, k.model);
    }
    // the first local task of the day hits a spare too: seed the local provider and the policy route for each of those repos
    const repos = [...new Set(keys.map((k) => repoRootOf(k.cwd)).filter((r): r is string => !!r))];
    if (repos.length) {
      const seed: Promise<void> = (opts.seedProviders ?? (opts.warmKeys ? async () => [] : defaultSeedProviders))()
        .then((names) => {
          for (const name of names) {
            const model = getProviderOrNative(config, name)?.models.default;
            if (model) for (const repo of repos) topUp(repo, name, model);
          }
        })
        .catch(() => undefined)
        .finally(() => pendingStarts.delete(seed));
      pendingStarts.add(seed);
    }
  }

  return {
    server,
    port,
    logDir,
    listening: () => {
      owned = true;
      persist();
    },
    state: () => ({ ...state, slots: [...slots.values()].map((s) => s.record) }),
    runTask,
    shutdown,
    reapSlots,
    settings: () => settings,
    offersModel,
    reloadSettings,
    reapSpares,
    refreshSpares,
    checkReload,
    retireSpares,
    checkCredentials,
    settle: async () => {
      while (pendingStarts.size) await Promise.all([...pendingStarts]);
    },
  };
}

/** A spare in the host: its record plus the claude process it holds (null while starting). */
interface SpareEntry {
  rec: PoolSpareRecord;
  session: PoolSlotSession | null;
  /** Marked for retirement (the login changed): never handed out; discarded once ready. */
  retiring?: boolean;
}
