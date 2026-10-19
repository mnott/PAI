/**
 * worker-trouble.ts — tell the session that started a worker when PAI's guards
 * hit it. Fed by the supervising `pai worker run` process (the one place each
 * denial is counted once), over the run-events messenger: session only, never
 * PAILot. At most one message per worker per TROUBLE_THROTTLE_MS; the hard
 * stop is always sent. A delivery failure is the messenger's to log.
 */

import { eventLine, type Messenger, type RunOrigin } from "./run-events.js";

export const TROUBLE_THROTTLE_MS = 5 * 60_000;
export const DENIAL_WINDOW_MS = 10 * 60_000;
export const DENIAL_THRESHOLD = 3;
export const STALL_MS = 10 * 60_000;

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
    if (!force && t - this.lastSent < TROUBLE_THROTTLE_MS) return;
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
    const t = this.now();
    this.denials = this.denials.filter((d) => t - d < DENIAL_WINDOW_MS);
    this.denials.push(t);
    const n = this.denials.length;
    if (n < DENIAL_THRESHOLD) return;
    const guard = hook.split("/").pop()?.replace(/\.(mjs|js|ts)$/, "") || "hook";
    this.send("guard-denials", { denied: n, guard }, `${this.who} blocked ${n}x by ${guard} in ${Math.round(DENIAL_WINDOW_MS / 60_000)} min: ${short(reason, 120)}`);
  }

  /** The loop guard's hard stop; always sent. */
  onLoopStop(reason: string): void {
    this.send("loop-stopped", {}, `${this.who} was stopped by the loop guard: ${short(reason, 160)}`, true);
  }

  /** Timer tick while running: no activity for STALL_MS tells once per quiet spell (throttled). */
  tick(): void {
    const quiet = this.now() - this.lastActivity;
    if (quiet < STALL_MS || this.stallTold) return;
    this.stallTold = true;
    this.send("stalled", { quiet_min: Math.round(quiet / 60_000) }, `${this.who} has produced no output for ${Math.round(quiet / 60_000)} min while running.`);
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}
