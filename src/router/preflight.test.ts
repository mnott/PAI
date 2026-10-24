import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { checkUpstream, preflightFirst, preflightUpstreams } from "./preflight.js";

const block = (ms: number): void => void execFileSync("/bin/sleep", [String(ms / 1000)]);

describe("checkUpstream under a blocked event loop", () => {
  it("is ok when the loop is blocked past the timeout but the connect works", async () => {
    const srv = createServer((s) => s.destroy());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const p = checkUpstream(`http://127.0.0.1:${port}`, 300);
    block(700); // timer due, connect callback queued behind it
    const r = await p;
    srv.close();
    expect(r.ok).toBe(true);
    expect(r.trace?.connectedAt).toBeGreaterThan(0);
  });

  it("still times out when nothing answers", async () => {
    const r = await checkUpstream("http://10.255.255.1:81", 200);
    expect(r.ok).toBe(false);
    expect(["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED"]).toContain(r.code);
  });
});

describe("preflightUpstreams", () => {
  it("aborts at once on ENOTFOUND, no retry", async () => {
    let calls = 0;
    const r = await preflightUpstreams("https://x.invalid", [], async (u) => (calls++, { ok: false, host: u, code: "ENOTFOUND" }), 10);
    expect(r.claude.code).toBe("ENOTFOUND");
    expect(calls).toBe(1);
  });
  it("retries ETIMEDOUT once", async () => {
    let calls = 0;
    const r = await preflightUpstreams("https://x.invalid", [], async (u) => (calls++ ? { ok: true, host: u } : { ok: false, host: u, code: "ETIMEDOUT" }), 10);
    expect(r.claude.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("preflightFirst", () => {
  it("runs the preflight before the sampler start and warmCockpit", async () => {
    const order: string[] = [];
    await preflightFirst(
      async () => void order.push("preflight"),
      () => {
        order.push("sampler");
        order.push("warmCockpit");
      }
    );
    expect(order).toEqual(["preflight", "sampler", "warmCockpit"]);
  });

  it("runs no startup work when the preflight fails", async () => {
    const sampler = vi.fn();
    const warm = vi.fn();
    await expect(preflightFirst(async () => { throw new Error("no upstream"); }, () => { sampler(); warm(); })).rejects.toThrow("no upstream");
    expect(sampler).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
  });
});
