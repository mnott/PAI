/**
 * worker-trouble.ts — tell the session that started a worker when PAI's guards
 * hit it. Fed by the supervising `pai worker run` process (the one place each
 * denial is counted once), over the run-events messenger: session only, never
 * PAILot. At most one message per worker per notices.trouble.throttleMinutes
 * (config); the hard stop is always sent. A delivery failure is the
 * messenger's to log.
 */

import { eventLine, type Messenger, type RunOrigin } from "./run-events.js";
import { troublePolicy } from "./notice-policy.js";
import { loadStatus } from "./status.js";
import { activeMsOf, frozenSince } from "./freeze.js";
import { appendDigest, classifyNotice, type NoticePriority } from "./notice-triage.js";

const short = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

/** A routine trouble line waits in the origin's digest; without any origin key
 *  there is no queue to join, and it goes out directly rather than vanish. */
async function queueDigest(logDir: string, msg: Messenger, origin: RunOrigin, text: string, now: number): Promise<boolean> {
  const key = origin.claudeSession || origin.iterm || origin.host || origin.name;
  if (!key) return msg.toSession(origin, text);
  return appendDigest(logDir, key, text, now);
}

/** Where a trouble line goes: straight to the session, or into its digest. */
export type TroubleRoute = (priority: NoticePriority, text: string) => Promise<boolean>;

export class TroubleWatcher {
  private denials: number[] = [];
  private lastSent = -Infinity;
  private lastActivity: number;
  private stallTold = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly id: string,
    private readonly label: string,
    private readonly msg: Messenger,
    private readonly origin: RunOrigin,
    /** The worker's status file is read per tick for the pause window (preemption and `pai worker pause` are not idleness). */
    private readonly logDir: string = "",
    private readonly now: () => number = Date.now,
    /** Delivery override (tests); default routes by priority through notice-triage. */
    private readonly deliver?: TroubleRoute,
  ) {
    this.lastActivity = now();
  }

  private send(kind: string, fields: Record<string, string | number>, sentence: string, force = false): void {
    const t = this.now();
    if (!force && t - this.lastSent < troublePolicy().throttleMs) return;
    this.lastSent = t;
    const text = eventLine(this.id, kind, fields, sentence);
    // urgent lines go out at once; routine ones (an in-line stall) join the
    // session's digest and leave as one batched message (notice-triage.ts).
    // The triage runs at send time, so a queued chain reads it fresh.
    const priority = classifyNotice(text);
    this.chain = this.chain.then(() =>
      (this.deliver ?? ((p, tx) =>
        p === "urgent" ? this.msg.toSession(this.origin, tx) : queueDigest(this.logDir, this.msg, this.origin, tx, this.now())
      ))(priority, text).catch(() => false)
    );
  }

  private get who(): string {
    return `worker ${this.id}${this.label ? ` (${short(this.label, 40)})` : ""}`;
  }

  /** Any sign of life (a transcript line); resets the stall clock. */
  activity(): void {
    this.lastActivity = this.now();
    this.stallTold = false;
  }

  /** Quiet ms on the active clock: frozen and paused spans never count, so after a thaw or a resume the quiet spell restarts from its end. */
  private quietMs(t: number): number {
    let pause = {};
    try {
      const s = this.logDir ? loadStatus(this.logDir, this.id) : null;
      pause = { paused: s?.paused, pausedAt: s?.pausedAt, pausedMs: s?.pausedMs };
    } catch {
      /* a status read that fails only loses the pause discount for one tick */
    }
    return activeMsOf(this.id, this.lastActivity, t, pause);
  }

  /** One guard denial; from the 3rd in the window on, tell the session (throttled). */
  onDenial(hook: string, reason: string): void {
    const policy = troublePolicy();
    const t = this.now();
    this.denials = this.denials.filter((d) => t - d < policy.denialWindowMs);
    this.denials.push(t);
    const n = this.denials.length;
    if (n < policy.denialThreshold) return;
    const guard = hook.split("/").pop()?.replace(/\.(mjs|js|ts)$/, "") || "hook";
    this.send("guard-denials", { denied: n, guard }, `${this.who} blocked ${n}x by ${guard} in ${Math.round(policy.denialWindowMs / 60_000)} min: ${short(reason, 120)}`);
  }

  /**
   * The loop guard's hard stop; always sent. `escalation` is the clause naming what the harness
   * decided after the stop — the continuation id ("; escalating to <provider> as <newid> (same
   * branch) - wait for it, do not restart") or "no escalation: <reason>". The caller sends this only
   * once the escalation is decided, so the notice never precedes the continuation it describes.
   */
  onLoopStop(reason: string, escalation?: string): void {
    const clause = escalation ? `; ${escalation}` : "";
    this.send("loop-stopped", {}, `${this.who} was stopped by the loop guard: ${short(reason, 160)}${clause}`, true);
  }

  /** Timer tick while running: no activity for notices.trouble.stallMinutes tells once per quiet spell (throttled). A worker stopped by the operator — listed in the active freeze marker, or paused (a --now preemption or `pai worker pause`) — is not stalled: it tells nothing, and its quiet clock restarts at the thaw or resume. */
  tick(): void {
    const t = this.now();
    if (frozenSince(this.id) !== undefined) return; // frozen: no stall notice, the frozen minutes never count
    try {
      const s = this.logDir ? loadStatus(this.logDir, this.id) : null;
      if (s?.paused) return; // paused by preemption or the operator: no stall notice, paused minutes never count
    } catch {
      /* a status read that fails reads as not paused */
    }
    const quiet = this.quietMs(t);
    if (quiet < troublePolicy().stallMs || this.stallTold) return;
    this.stallTold = true;
    this.send("stalled", { quiet_min: Math.round(quiet / 60_000) }, `${this.who} has produced no output for ${Math.round(quiet / 60_000)} min while running.`);
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}
