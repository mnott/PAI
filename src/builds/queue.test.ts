import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { breakStaleMutex, enqueue, listBuilds } from "./queue.js";

function ageDir(p: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  utimesSync(p, t, t);
}

describe("breakStaleMutex", () => {
  it("removes a mutex whose holder died, keeps a fresh one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutex-"));
    const m = join(dir, "mutex");
    mkdirSync(m);
    breakStaleMutex(m);
    expect(existsSync(m)).toBe(true);
    ageDir(m, 10_000);
    breakStaleMutex(m);
    expect(existsSync(m)).toBe(false);
    expect(existsSync(`${m}.break`)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it("two waiters that both saw the stale mutex: the second leaves the new holder's mutex alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutex-"));
    const m = join(dir, "mutex");
    mkdirSync(m);
    ageDir(m, 10_000);
    breakStaleMutex(m); // waiter A breaks it
    mkdirSync(m); // a third party takes the lock
    breakStaleMutex(m); // waiter B, which had also seen the old one
    expect(existsSync(m)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("a breaker holding the guard blocks a concurrent breaker", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutex-"));
    const m = join(dir, "mutex");
    mkdirSync(m);
    ageDir(m, 10_000);
    mkdirSync(`${m}.break`); // another waiter is mid-break
    breakStaleMutex(m);
    expect(existsSync(m)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("concurrent enqueues behind a stale mutex all get distinct tickets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mutex-"));
    mkdirSync(join(dir, "mutex"));
    ageDir(join(dir, "mutex"), 10_000);
    const info = { pid: process.pid, label: "l", session: "s", cmd: "true", mode: "delta" as const };
    const ids = await Promise.all([1, 2, 3, 4].map(() => enqueue(dir, info)));
    expect(new Set(ids.map((t) => t.id)).size).toBe(4);
    expect(await listBuilds(dir)).toHaveLength(4);
    rmSync(dir, { recursive: true });
  });
});
