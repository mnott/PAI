import { describe, expect, it } from "vitest";
import { Snapshot } from "./memory-snapshot.js";
import { memoryBacklog } from "./daemon/dashboard-live.js";
import type { StorageBackend } from "../storage/interface.js";

/** A pg Pool stand-in: `max` connections, a waiter errors after `timeoutMs`, a query holds its connection `queryMs`. */
class FakePool {
  private busy = 0;
  private waiters: Array<() => void> = [];
  queries = 0;
  peak = 0;
  constructor(private max: number, private timeoutMs: number, private queryMs: number) {}
  private acquire(): Promise<void> {
    if (this.busy < this.max) { this.busy++; this.peak = Math.max(this.peak, this.busy); return Promise.resolve(); }
    return new Promise((res, rej) => {
      const w = () => { clearTimeout(t); this.busy++; this.peak = Math.max(this.peak, this.busy); res(); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("Connection terminated due to connection timeout")); }, this.timeoutMs);
      this.waiters.push(w);
    });
  }
  async query(): Promise<number> {
    await this.acquire();
    this.queries++;
    try { await new Promise((r) => setTimeout(r, this.queryMs)); return 122_303; }
    finally { this.busy--; this.waiters.shift()?.(); }
  }
}

const storageOf = (pool: FakePool) => ({ countUnembeddedChunks: () => pool.query() }) as unknown as StorageBackend;

describe("dashboard backlog under concurrent cockpit polls", () => {
  // 5 connections, 300 ms queries, 100 ms connect timeout: 20 polls at once (several tabs)
  it("reproduces the timeout when every request runs its own COUNT(*)", async () => {
    const pool = new FakePool(5, 100, 300);
    const st = storageOf(pool);
    const r = await Promise.allSettled(Array.from({ length: 20 }, () => st.countUnembeddedChunks()));
    expect(r.filter((x) => x.status === "rejected").length).toBeGreaterThan(0);
  });

  it("serves 20 concurrent requests from one shared query and no timeout", async () => {
    const pool = new FakePool(5, 100, 300);
    const st = storageOf(pool);
    const r = await Promise.allSettled(Array.from({ length: 20 }, () => memoryBacklog(st)));
    expect(r.every((x) => x.status === "fulfilled" && x.value === 122_303)).toBe(true);
    expect(pool.queries).toBe(1);
    expect(pool.peak).toBe(1);
    await memoryBacklog(st);
    expect(pool.queries).toBe(1); // within the TTL: no query at all
  });
});

describe("Snapshot", () => {
  it("keeps the last good value and counts consecutive failures", async () => {
    let t = 0, fail = false, calls = 0;
    const s = new Snapshot(async () => { calls++; if (fail) throw new Error("boom"); return calls; }, 1000, () => t);
    expect(await s.get()).toBe(1);
    fail = true; t = 1000;
    expect(await s.get()).toBe(1); // refresh starts in the background, old value served
    await new Promise((r) => setTimeout(r, 5));
    t = 2000; await s.get(); await new Promise((r) => setTimeout(r, 5));
    expect(s.health()).toMatchObject({ failures: 2, failingSince: 1000, error: "boom", okAt: 0 });
    fail = false; t = 3000; await s.get(); await new Promise((r) => setTimeout(r, 5));
    expect(s.health()).toMatchObject({ failures: 0, failingSince: null });
    expect(await s.get()).toBe(4);
  });
});
