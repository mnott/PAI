/**
 * plan-follow.ts — what the plan pane shows besides the runner's phases: the
 * live transcript of the part workers, the view `pai worker follow <id>` gives.
 * One worker is shown plain; with several running at once (max_parallel > 1)
 * their lines are interleaved and prefixed with the part id.
 */

import { existsSync, readFileSync } from "node:fs";
import { eventsPath } from "./paths.js";
import { loadPlanStatus } from "./plan-status.js";
import { makeColor, type StreamEventLike } from "./render.js";
import { applyEvent, initialFollowState, type FollowState } from "./viewer.js";

interface Tailed {
  part: string;
  wid: string;
  at: number;
  buf: string;
  state: FollowState;
}

export class PlanFollower {
  private tailed = new Map<string, Tailed>();

  constructor(
    private logDir: string,
    private planId: string,
    private color = process.stdout.isTTY === true
  ) {}

  /** New transcript text since the last call: a header per worker that starts, then its rendered events. */
  poll(): string {
    const workers = loadPlanStatus(this.logDir, this.planId)?.workers ?? {};
    for (const [part, wid] of Object.entries(workers)) {
      if (!this.tailed.has(wid)) this.tailed.set(wid, { part, wid, at: 0, buf: "", state: initialFollowState("") });
    }
    const c = makeColor(this.color);
    const prefix = this.tailed.size > 1 && Object.keys(workers).length > 1;
    const out: string[] = [];
    for (const t of this.tailed.values()) {
      const path = eventsPath(this.logDir, t.wid);
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, "utf8");
      if (t.at === 0) out.push(c("dim", `── following ${t.part} (${t.wid}) ──`));
      t.buf += raw.slice(t.at);
      t.at = raw.length;
      const lines = t.buf.split("\n");
      t.buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let e: StreamEventLike;
        try {
          e = JSON.parse(line) as StreamEventLike;
        } catch {
          continue;
        }
        const step = applyEvent(c, t.state, e, "", undefined, undefined, null);
        t.state = step.state;
        for (const l of step.lines) out.push(prefix ? `[${t.part}] ${l}` : l);
      }
    }
    return out.length ? out.join("\n") + "\n" : "";
  }
}
