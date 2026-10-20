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

const short = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

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
    private readonly now: () => number = Date.now,
  ) {
    this.lastActivity = now();
  }

  private send(kind: string, fields: Record<string, string | number>, sentence: string, force = false): void {
    const t = this.now();
    if (!force && t - this.lastSent < troublePolicy().throttleMs) return;
    this.lastSent = t;
    const text = eventLine(this.id, kind, fields, sentence);
    this.chain = this.chain.then(() => this.msg.toSession(this.origin, text).catch(() => false));
  }

  private get who(): string {
    return `worker ${this.id}${this.label ? ` (${short(this.label, 40)})` : ""}`;
  }

  /** Any sign of life (a transcript line); resets the stall clock. */
  activity(): void {
    this.lastActivity = this.now();
    this.stallTold = false;
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

  /** The loop guard's hard stop; always sent. */
  onLoopStop(reason: string): void {
    this.send("loop-stopped", {}, `${this.who} was stopped by the loop guard: ${short(reason, 160)}`, true);
  }

  /** Timer tick while running: no activity for notices.trouble.stallMinutes tells once per quiet spell (throttled). */
  tick(): void {
    const quiet = this.now() - this.lastActivity;
    if (quiet < troublePolicy().stallMs || this.stallTold) return;
    this.stallTold = true;
    this.send("stalled", { quiet_min: Math.round(quiet / 60_000) }, `${this.who} has produced no output for ${Math.round(quiet / 60_000)} min while running.`);
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}
