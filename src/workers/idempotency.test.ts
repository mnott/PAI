import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_TTL_MS, claimIdempotency, sweepIdempotency } from "./idempotency.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pai-idem-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("claimIdempotency", () => {
  it("a repeat returns the first worker and does not claim again", async () => {
    const a = await claimIdempotency(dir, "k1", { p: "task" });
    expect(a.kind).toBe("new");
    if (a.kind === "new") a.record("w-1");
    const b = await claimIdempotency(dir, "k1", { p: "task" });
    expect(b).toEqual({ kind: "replay", workerId: "w-1" });
  });
  it("two racing callers: one new, the other waits and replays its id", async () => {
    const a = await claimIdempotency(dir, "race", { p: 1 });
    expect(a.kind).toBe("new");
    const second = claimIdempotency(dir, "race", { p: 1 }, { waitMs: 3000 });
    setTimeout(() => a.kind === "new" && a.record("w-race"), 150);
    expect(await second).toEqual({ kind: "replay", workerId: "w-race" });
  }, 5000);
  it("same key, different request: invalid_input", async () => {
    const a = await claimIdempotency(dir, "k2", { p: "one" });
    if (a.kind === "new") a.record("w-2");
    await expect(claimIdempotency(dir, "k2", { p: "two" })).rejects.toMatchObject({ error: { code: "invalid_input", type: "invalid_request_error" } });
  });
  it("release lets a retry run; entries expire after 24 h", async () => {
    const a = await claimIdempotency(dir, "k3", { p: 1 });
    if (a.kind === "new") a.release();
    expect((await claimIdempotency(dir, "k3", { p: 1 })).kind).toBe("new");
    const old = await claimIdempotency(dir, "k4", { p: 1 }, { now: Date.now() - IDEMPOTENCY_TTL_MS - 1000 });
    if (old.kind === "new") old.record("w-old");
    expect((await claimIdempotency(dir, "k4", { p: 1 })).kind).toBe("new");
    expect(sweepIdempotency(dir)).toBe(0);
  });
});
