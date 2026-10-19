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

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";
import { openSync, closeSync, writeSync, mkdirSync, statSync, readSync, readFileSync } from "node:fs";
import { loadConfig } from "../daemon/config.js";
import { appendSystemPromptArgs } from "./args.js";
import { validateAg2 } from "./agentish.js";
import { getProviderOrNative, readWorkersSection, type WorkerProvider, type WorkersConfig } from "./config.js";
import { buildRunEnv, claudeCommand, isLoopbackProvider, loopbackRouterChoice } from "./run-env.js";
import { probeRouter } from "../router/supervisor.js";
import { appendLedger } from "./ledger.js";
import { ensureNoMcpConfig, eventsPath, ledgerPath, workersLogDir } from "./paths.js";
import { nowStamp, saveStatus, describeTool, parseSleepSecs, type WorkerStatus } from "./status.js";
import { loadContractAddendum } from "./contract-addendum.js";
import { poolSlotSettingsId, slimProfileArgs, WORKER_BRIEF } from "./slim-profile.js";
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
  type StreamEvent,
} from "./run.js";
import type { UsageBlock } from "../utils/input-side-tokens.js";
import { POOL_SLOT_ENV, clearSlotCurrent, setSlotCurrent } from "./worker-id.js";
import { slotsDir, ensureSlotWorktree, prepareSlot, releaseSlot, slotPath, slotServesRepo, type SlotPrep } from "./slots.js";
import { commitsSince, salvageNotes, salvageOnExit, worktreeSystemPrompt } from "./worktree.js";
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
  poolSettings,
  readPoolMetrics,
  slotKey,
  slotShouldReap,
  warmOrCold,
  writePoolState,
  type PoolSlotRecord,
  type PoolState,
  type PoolTaskRequest,
  type PoolTaskResponse,
  type SlotProcess,
  type SlotSpawner,
} from "./pool.js";
import { usageLogFile } from "../router/usage.js";

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
  cmdHead?: (env: NodeJS.ProcessEnv, caveman: boolean) => string[];
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
}

export interface PoolHost {
  server: Server;
  port: number;
  logDir: string;
  state(): PoolState;
  /** Run one task through the pool; the /task route body. */
  runTask(task: PoolTaskRequest, clientGone?: AbortSignal): Promise<PoolTaskResponse>;
  /** Kill every slot, write final state, close the server. */
  shutdown(): Promise<void>;
  reapSlots(): number;
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
  const { workers: config } = opts.config ? { workers: opts.config } : readWorkersSection();
  const logDir = opts.logDir ?? workersLogDir(config);
  const settings = poolSettings(config);
  const port = opts.port ?? poolPort(config);
  const spawner = opts.spawner ?? realSpawner;
  // one router decision for both builders: the env carries the router route,
  // the argv pins it again via --settings (the user settings' env outranks
  // the process env — see pinnedSettingsArgs)
  const routerOn = opts.routerEnabled ?? loadConfig().router.enabled;
  const envFor = opts.envFor ?? ((name: string, p: WorkerProvider, via?: boolean) => buildRunEnv(p, true, undefined, name, via ?? routerOn));
  const cmdHead = opts.cmdHead ?? ((env: NodeJS.ProcessEnv, caveman: boolean) => claudeCommand(env, caveman, routerOn));
  const now = opts.now ?? (() => new Date());
  const ledger = ledgerPath(logDir);
  mkdirSync(logDir, { recursive: true });

  const slots = new Map<string, PoolSlotSession>();
  const state: PoolState = {
    hostPid: process.pid,
    port,
    startedAt: nowStamp(now()),
    updatedAt: nowStamp(now()),
    slots: [],
    tasksServed: 0,
    tokensCarried: 0,
  };

  const persist = (): void => {
    state.updatedAt = nowStamp(now());
    state.slots = [...slots.values()].map((s) => s.record);
    writePoolState(state, poolStatePath(logDir));
  };
  persist();

  const dropSlot = (key: string, why: string): void => {
    const s = slots.get(key);
    if (!s) return;
    slots.delete(key);
    if (!s.dead) s.kill();
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
    shared?: string | null
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
    let cmd: string[] = [...cmdHead(env, config.caveman)];
    const addendum = loadContractAddendum(providerName, provider.contract);
    cmd.push("--model", model);
    cmd.push("--strict-mcp-config", "--mcp-config", ensureNoMcpConfig(logDir));
    cmd.push(...headlessToolGrants([]));
    // a slot is born like a bare headless worker: the default core grant,
    // narrowed schemas (headlessToolsFlag([]) names none) included
    cmd.push(...(headlessToolsFlag([]).length ? headlessToolsFlag([]) : ["--tools", DEFAULT_WORKER_TOOLS]));
    const slim = slimProfileArgs(logDir, poolSlotSettingsId(providerName, model), [], env, undefined, provider);
    cmd.push(...slim);
    cmd.push("--output-format", "stream-json", "--verbose", "--input-format", "stream-json");
    // stream-json input is a print-mode feature: without -p the CLI would
    // start the interactive REPL over the pipes and never speak stream-json
    cmd.push("-p");
    cmd.push(
      ...appendSystemPromptArgs([
        "You are a pooled worker session: each user turn is a NEW, unrelated task introduced by a " +
          "system-reminder boundary line. Never carry context between tasks; answer each task only " +
          "from its own spec.",
        `Working directory: ${cwd} (fixed for the whole session).`,
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

  /** One pooled task, end to end. */
  const runTask = async (task: PoolTaskRequest, clientGone?: AbortSignal): Promise<PoolTaskResponse> => {
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
      slotWorktree: isLoopbackProvider(provider),
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
    // a worktree task runs in the slot's own worktree on a fresh branch; every
    // other task runs in the cwd it came with
    let prep: SlotPrep | null = null;
    let session: PoolSlotSession | null;
    const split = splitSharedSpec(task.prompt);
    if (task.worktree) {
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
    const workDir = prep?.dir ?? task.cwd;

    const taskNo = session.record.tasks + 1;
    session.record.busyWith = wid;
    persist();

    const started = now();
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
      pool: { task: taskNo, slotSession: session.record.claudeSession, hostPid: process.pid, ...(prep ? { slot: prep.dir } : {}) },
      ...(prep ? { branch: prep.branch, worktreeDir: prep.dir, worktreeBase: prep.base, worktreeSnapshot: false } : {}),
    };
    saveStatus(logDir, status);
    if (session.slotName) setSlotCurrent(logDir, session.slotName, wid);
    appendLedger(ledger, "WORKER-START", {
      id: wid,
      provider: task.provider,
      mode: "pooled",
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
        bumpContextTokens(status, usageContextTokens(e.message?.usage));
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
        // when no assistant usage carried numbers
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
    const text = pooledTaskText(taskNo, workDir, pooledUnitPrompt(unitSpec, wtNote), task.trailer);
    let resultEvent = await session.feed(text, onEvent);
    if (deadTimer) clearTimeout(deadTimer);
    clientGone?.removeEventListener("abort", onClientGone);

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
      if (task.reportFormat === "ag2" && resultEvent.result && !validateAg2(resultEvent.result).ok) {
        const v = validateAg2(resultEvent.result);
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

    // the slot moves on to its next task: commit what this one left, carry its
    // Notes/ into the repo, and put the slot on a detached HEAD so the branch
    // is free for `pai worker merge`
    if (prep) {
      try {
        salvageOnExit(ledger, wid, task.label, prep.dir);
        for (const l of salvageNotes(task.cwd, prep.dir, wid)) appendLedger(ledger, "WORKER-NOTE", { id: wid, note: l });
        const had = commitsSince(prep.dir, prep.base);
        const { commits } = releaseSlot(prep.dir, prep.branch, prep.base);
        session.record.branch = null;
        if (commits > 0 || had > 0) status.commits = commits;
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
    const ok = !status.timedOut && !clientGoneFired && rc === 0 && !empty;
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
    if (session.dead) dropSlot(slotKey(task.provider, task.model, workDir), "slot exited after task");
    // a worktree task gets a fresh conversation: the process ends, the next task spawns a new one in the same slot dir
    else if (prep) dropSlot(slotKey(task.provider, task.model, workDir), "fresh conversation per worktree task");

    return { pooled: true, rc, resultEvent, report, status };
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      persist();
      sendJson(res, 200, { ...state, carry: poolCarry(readPoolMetrics(poolMetricsPath(logDir))) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      sendJson(res, 200, { ok: true });
      void shutdown();
      return;
    }
    if (req.method === "POST" && url.pathname === "/task") {
      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) gone.abort();
      });
      void readBody(req).then(async (body) => {
        if (!body) return sendJson(res, 400, { pooled: false, reason: "host-error" });
        let task: PoolTaskRequest;
        try {
          task = JSON.parse(body) as PoolTaskRequest;
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
    persist();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const reapSlots = (): number => {
    let n = 0;
    for (const [k, s] of slots) {
      if (slotShouldReap(s.record, now().getTime(), settings.idleSecs)) {
        dropSlot(k, "idle timeout");
        n++;
      }
    }
    return n;
  };

  if (!opts.noReaper && settings.idleSecs > 0) {
    const timer = setInterval(reapSlots, 30_000);
    timer.unref?.();
  }

  return {
    server,
    port,
    logDir,
    state: () => ({ ...state, slots: [...slots.values()].map((s) => s.record) }),
    runTask,
    shutdown,
    reapSlots,
  };
}
