/**
 * run-events.ts — report plan and queue runs back into the conversation.
 *
 * The operator never polls: a run reports the moments that need them to the
 * session that started it (AIBroker send_to_session, so the session wakes and
 * can talk to the operator). Automatic notices never go to PAILot (operator
 * rule 2026-10-20). A run
 * started with --detach is registered under <logDir>/runs and keeps going
 * after the starting session ends. Everything outside the process (AIBroker,
 * clock, spawning) goes through injected functions; tests never send.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idleText, type RunLogEntry } from "./plan-runner.js";
import { guardedPailot } from "./pailot-guard.js";
import type { QueueItem } from "./queue.js";

/** The session that started a run: where its events go. */
export interface RunOrigin {
  claudeSession?: string;
  /** iTerm2 session uuid (AIBroker target). */
  iterm?: string;
  /** PAI / AIBroker session name. */
  name?: string;
  /** Host iTerm uuid resolveHostSession found for the originating session at run start — the target when `iterm` is empty (a background session has no ITERM_SESSION_ID). */
  host?: string;
}

export interface Messenger {
  /** Type a message into the originating session. */
  toSession(origin: RunOrigin, text: string): Promise<boolean>;
  /** Why the last toSession returned false, when known. */
  lastError?: string;
  /** Short plain sentence to the operator's phone. */
  /** Explicit, operator-requested sends only. No automatic notice may call this (operator rule 2026-10-20). */
  toPailot(text: string): Promise<boolean>;
}

export const PLAN_GROUP_THROTTLE_MS = 15 * 60_000;
export const QUEUE_READY_BATCH_MS = 10 * 60_000;

/** The origin of the calling session, from its environment. */
export function originFromEnv(env: NodeJS.ProcessEnv = process.env): RunOrigin {
  if (env.PAI_RUN_ORIGIN) {
    try {
      return JSON.parse(env.PAI_RUN_ORIGIN) as RunOrigin;
    } catch {
      /* fall through to the live environment */
    }
  }
  const o: RunOrigin = {};
  if (env.CLAUDE_CODE_SESSION_ID) o.claudeSession = env.CLAUDE_CODE_SESSION_ID;
  const iterm = env.ITERM_SESSION_ID?.split(":").pop();
  if (iterm) o.iterm = iterm;
  const name = env.PAI_WORKER_PARENT ?? env.PAI_SESSION_NAME ?? env.AIBROKER_SESSION_NAME ?? env.AIBROKER_SESSION;
  if (name) o.name = name;
  return o;
}

/** The origin's AIBroker target: its own uuid, else the host resolveHostSession recorded, else its name. */
export function originTarget(origin: RunOrigin): string | undefined {
  return origin.iterm?.split(":").pop() || origin.host || origin.name || undefined; // ITERM_SESSION_ID form "w8t0p0:<uuid>" -> the uuid
}

/** Real messenger over AIBroker's socket; unreachable AIBroker is logged and ignored. */
export function aibrokerMessenger(
  logDir: string,
  warn: (s: string) => void = (s) => process.stderr.write(s + "\n"),
  resolveHost: (claudeSession: string) => Promise<string> = async () => "",
  send: (target: string, text: string) => Promise<{ ok: boolean; timedOut?: boolean; error?: string }> = async (target, text) => {
    // lazy import: the live client loads only when a message is actually sent
    const { sendToSession } = await import("../cli/lib/aibroker-client.js");
    return sendToSession(target, text);
  },
  toPailot: (text: string) => Promise<boolean> = (text) =>
    guardedPailot(logDir, text, async (t) => {
      try {
        const { callAiBroker } = await import("../cli/lib/aibroker-client.js");
        await callAiBroker("pailot_send", { text: t }, 8_000);
        return true;
      } catch (e) {
        warn(`run report not delivered to PAILot: ${String(e)}`);
        return false;
      }
    }),
): Messenger {
  const self: Messenger = {
    async toSession(origin, text) {
      self.lastError = undefined;
      const fail = (why: string): false => {
        self.lastError = why;
        warn(`run report not delivered to the session: ${why}`);
        return false;
      };
      try {
        let target = originTarget(origin);
        // a background session records no iterm: fall back to the host resolver for its Claude session
        if (!target && origin.claudeSession) target = (await resolveHost(origin.claudeSession)) || undefined;
        if (!target) {
          return fail("the run has no originating session");
        }
        const r = await send(target, text);
        if (!r.ok && !r.timedOut) return fail(`${target}: ${r.error}`);
        return r.ok || r.timedOut === true;
      } catch (e) {
        return fail(String(e));
      }
    },
    toPailot,
  };
  return self;
}

const short = (s: string | undefined, n = 160): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const mins = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? `${Math.round(ms / 1000)}s` : `${m} min`;
};
const fmtTok = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/** AG2-style kind line plus a plain sentence, one line (it is typed into a terminal). */
export function eventLine(id: string, kind: string, fields: Record<string, string | number>, sentence: string): string {
  const kv = Object.entries(fields).map(([k, v]) => `${k}=${String(v).replace(/[|\n]/g, " ")}`);
  return `S i=${id} z=${kind}${kv.length ? " | " + kv.join(" | ") : ""} — ${sentence}`;
}

abstract class Reporter {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(protected readonly msg: Messenger, protected readonly origin: RunOrigin, protected readonly now: () => number) {}
  protected send(text: string): void {
    this.chain = this.chain.then(async () => {
      await this.msg.toSession(this.origin, text).catch(() => false);
    });
  }
  /** Wait for every queued message; call before the process exits. */
  async flush(): Promise<void> {
    await this.chain;
  }
}

/** Turns the plan runner's log entries into messages. Feed it every entry via `onLog`. */
export class PlanReporter extends Reporter {
  private readonly start: number;
  private localTokens = 0;
  private cloudTokens = 0;
  private idleMs = 0;
  private overlaps = 0;
  private escalations = 0;
  private merged = 0;
  private readonly nd: string[] = [];
  private lastGroup = -Infinity;
  private pendingGroups: string[] = [];

  constructor(private readonly job: string, private readonly totalParts: number, msg: Messenger, origin: RunOrigin, now: () => number = Date.now) {
    super(msg, origin, now);
    this.start = now();
  }

  private get id(): string {
    return `plan:${this.job}`;
  }

  onLog(e: RunLogEntry): void {
    if (e.event === "part-end" && typeof e.tokens === "number") {
      if (e.tier === "sonnet") this.cloudTokens += e.tokens;
      else this.localTokens += e.tokens;
    }
    if (e.event === "model-idle" && e.tier === "local" && typeof e.ms === "number") this.idleMs += e.ms;
    if (e.event === "part-start" && e.overlap) this.overlaps++;
    if (e.event === "escalate") this.escalations++;
    if (e.event === "merge" && e.ok) this.merged++;
    if (e.event === "needs-decision" && e.part) {
      this.nd.push(e.part);
      this.send(
        eventLine(this.id, "needs-decision", { part: e.part }, `Part ${e.part} of ${this.job} failed twice and needs your decision: ${short(e.note)}`),
      );
    }
    if (e.event === "unit-check" && e.ok === false) {
      this.send(eventLine(this.id, "unit-check-failed", { unit: e.unit ?? "?" }, `The check after unit ${e.unit} of ${this.job} failed: ${short(e.note)}`));
    }
    if (e.event === "unit-done" && e.unit) this.unitDone(e.unit);
    if (e.event === "run-end") this.runEnd(e);
  }

  private unitDone(unit: string): void {
    this.pendingGroups.push(unit);
    const t = this.now();
    if (t - this.lastGroup < PLAN_GROUP_THROTTLE_MS) return;
    this.lastGroup = t;
    const units = this.pendingGroups.splice(0);
    this.send(eventLine(this.id, "unit-done", { units: units.join(",") }, `${this.job}: ${units.length === 1 ? "unit" : "units"} ${units.join(", ")} finished; ${this.merged} of ${this.totalParts} parts merged so far.`));
  }

  private runEnd(e: RunLogEntry): void {
    const outcome = e.ok ? "merged" : e.status === "blocked" ? "blocked" : "failed";
    const wallMs = this.now() - this.start;
    const wall = mins(wallMs);
    const idle = idleText(this.idleMs, wallMs, this.overlaps);
    const stats = { outcome, wall, merged: `${this.merged}/${this.totalParts}`, escalations: this.escalations, local_tokens: this.localTokens, cloud_tokens: this.cloudTokens, idle: idle.replace(/^local model idle /, "") };
    const what =
      outcome === "merged"
        ? `${this.job} is done: all ${this.totalParts} parts merged in ${wall}.`
        : outcome === "blocked"
          ? `${this.job} is blocked after ${wall}: ${this.merged} of ${this.totalParts} parts merged, the rest wait on ${this.nd.join(", ") || "a failed check"}. It needs your decision.`
          : `${this.job} ended with failures after ${wall}: ${this.merged} of ${this.totalParts} parts merged${this.nd.length ? `, ${this.nd.join(", ")} need your decision` : ""}.`;
    const extra = ` Escalations ${this.escalations}, ${fmtTok(this.localTokens)} local tokens, ${fmtTok(this.cloudTokens)} cloud tokens; ${idle}.`;
    this.send(eventLine(this.id, "run-" + outcome, stats, what + extra));
  }
}

/** Queue events: needs-decision at once, ready items batched. */
export class QueueReporter extends Reporter {
  private readyBatch: QueueItem[] = [];
  private lastReady = -Infinity;

  constructor(private readonly project: string, msg: Messenger, origin: RunOrigin, now: () => number = Date.now) {
    super(msg, origin, now);
  }

  private get id(): string {
    return `queue:${this.project}`;
  }

  onReady(item: QueueItem): void {
    this.readyBatch.push(item);
    if (this.now() - this.lastReady >= QUEUE_READY_BATCH_MS) this.sendReady();
  }

  onNeedsDecision(item: QueueItem): void {
    this.send(eventLine(this.id, "needs-decision", { item: item.id }, `Queue item ${item.id} ("${short(item.text, 80)}") failed twice and needs your decision: ${short(item.why)}`));
  }

  private sendReady(): void {
    const items = this.readyBatch.splice(0);
    if (!items.length) return;
    this.lastReady = this.now();
    const list = items.map((i) => `${i.id} "${short(i.text, 60)}"`).join(", ");
    this.send(eventLine(this.id, "ready", { items: items.map((i) => i.id).join(",") }, `${items.length === 1 ? "One queue item is" : `${items.length} queue items are`} ready for review: ${list}.`));
  }

  /** Send what the throttle held back; call once the run is over. */
  async finish(): Promise<void> {
    this.sendReady();
    await this.flush();
  }
}

// ---------------------------------------------------------------------------
// detach: registry of runs that outlive their session

export interface RunRecord {
  id: string;
  kind: "plan" | "queue";
  pid: number;
  argv: string[];
  cwd: string;
  origin: RunOrigin;
  started: string;
  output: string;
}

export const runsDir = (logDir: string): string => join(logDir, "runs");
export const runRecordPath = (logDir: string, id: string): string => join(runsDir(logDir), `${id}.json`);

export interface DetachDeps {
  /** Start `bin args` detached with stdout/stderr to `outFd`; returns the pid. */
  spawnDetached(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; outPath: string }): number;
  now(): number;
}

export const realDetachDeps: DetachDeps = {
  spawnDetached(bin, args, { cwd, env, outPath }) {
    const fd = openSync(outPath, "a");
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    return child.pid ?? 0;
  },
  now: Date.now,
};

/**
 * Hand a run to a detached process and register it. `argv` is the pai
 * command line of the run without --detach; the origin travels in the env so
 * the child reports to the session that started it.
 */
export function detachRun(
  logDir: string,
  kind: "plan" | "queue",
  label: string,
  bin: string,
  argv: string[],
  cwd: string,
  origin: RunOrigin,
  deps: DetachDeps = realDetachDeps,
): RunRecord {
  mkdirSync(runsDir(logDir), { recursive: true });
  const stamp = new Date(deps.now()).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const id = `${kind}-${label.replace(/[^\w.-]/g, "_")}-${stamp}`;
  const output = join(runsDir(logDir), `${id}.out`);
  const pid = deps.spawnDetached(bin, argv, { cwd, env: { ...process.env, PAI_RUN_ORIGIN: JSON.stringify(origin), PAI_RUN_ID: id }, outPath: output });
  const rec: RunRecord = { id, kind, pid, argv: [bin, ...argv], cwd, origin, started: new Date(deps.now()).toISOString(), output };
  writeFileSync(runRecordPath(logDir, id), JSON.stringify(rec, null, 2) + "\n", "utf8");
  return rec;
}

export function listRuns(logDir: string): RunRecord[] {
  const dir = runsDir(logDir);
  if (!existsSync(dir)) return [];
  const out: RunRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as RunRecord);
    } catch {
      /* torn record */
    }
  }
  return out;
}

/** The detached child calls this on a clean end, so the sweep does not report it as dead. */
export function markRunDone(logDir: string, id: string, now: () => number = Date.now): void {
  try {
    writeFileSync(`${runRecordPath(logDir, id)}.done`, new Date(now()).toISOString(), "utf8");
  } catch {
    /* the registry is a courtesy; the run's own result stands */
  }
}

/**
 * Daemon tick: a registered run whose process is gone without a done marker
 * died silently; tell its session once.
 */
export async function sweepRuns(logDir: string, msg: Messenger, isAlive: (pid: number) => boolean, now: () => number = Date.now): Promise<string[]> {
  const told: string[] = [];
  for (const r of listRuns(logDir)) {
    const marker = `${runRecordPath(logDir, r.id)}.done`;
    if (existsSync(marker) || isAlive(r.pid)) continue;
    markRunDone(logDir, r.id, now);
    const what = `The detached ${r.kind} run ${r.id} stopped without finishing; see ${r.output}.`;
    await msg.toSession(r.origin, eventLine(r.id, "run-died", { output: r.output }, what)).catch(() => false);
    told.push(r.id);
  }
  return told;
}
