/**
 * tool-call-hits.ts — per-rule hit counters of the tool-call repair, kept in
 * memory and flushed to <PAI home>/logs/tool-call-rule-hits.json every minute
 * (and at exit). The file is read-add-written so several processes (router,
 * `pai models rules test`) add to it instead of overwriting each other. A rule
 * with no recent hit is reported stale by `pai models rules list`; nothing is
 * ever deleted automatically.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paiHomePath } from "../config/pai-home.js";

export interface RuleHit {
  hits: number;
  last_hit: string;
}
export type HitsFile = Record<string, RuleHit>;

export function hitsPath(): string {
  return paiHomePath("logs", "tool-call-rule-hits.json");
}

export function readHits(path: string = hitsPath()): HitsFile {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as HitsFile;
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

export class RuleHitCounter {
  private pending = new Map<string, { n: number; last: string }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly path: () => string = hitsPath,
    private readonly now: () => Date = () => new Date(),
    private readonly flushMs = 60_000
  ) {}

  /** Counts one hit per rule id (pseudo ids such as coerce:number are not rules and are skipped). */
  record(ids: readonly string[]): void {
    const at = this.now().toISOString();
    for (const id of ids) {
      if (id.startsWith("coerce:")) continue;
      const p = this.pending.get(id) ?? { n: 0, last: at };
      p.n++;
      p.last = at;
      this.pending.set(id, p);
    }
    if (this.pending.size && !this.timer) {
      this.timer = setInterval(() => this.flush(), this.flushMs);
      this.timer.unref();
    }
  }

  flush(): void {
    if (!this.pending.size) return;
    const path = this.path();
    try {
      const cur = readHits(path);
      for (const [id, p] of this.pending) {
        const c = cur[id];
        cur[id] = { hits: (c?.hits ?? 0) + p.n, last_hit: c && c.last_hit > p.last ? c.last_hit : p.last };
      }
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n");
      renameSync(tmp, path);
      this.pending.clear();
    } catch {
      /* keep the pending counts, retry at the next flush */
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
  }
}

/** The router's shared counter. */
export const ruleHits = new RuleHitCounter();
process.on("exit", () => ruleHits.flush());
