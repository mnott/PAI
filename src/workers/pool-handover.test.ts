/**
 * pool-handover.test.ts — a reload never leaves the pool without a host: only the spawned successor's own
 * answer counts as a handover, and a lost host is started again by whoever reads the pool status.
 * Fake hosts on ephemeral ports (never the real pool port).
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poolHostPid } from "./pool.js";
import { waitForSuccessor } from "./pool-host-run.js";
import { ensurePoolHost, resetPoolHeal } from "./pool-cli.js";

const servers: Server[] = [];

/** A fake host: answers /healthz with the given pid header. Port 0 = free port. */
function fakeHost(pid: number, port = 0): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "x-pool-host-pid": String(pid) });
      res.end("ok");
    });
    servers.push(server);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

const noSleep = async (): Promise<void> => undefined;

describe("waitForSuccessor", () => {
  it("accepts the child's own answer", async () => {
    const { port } = await fakeHost(4242);
    expect(await waitForSuccessor({ childPid: 4242, exited: () => false, answeringPid: () => poolHostPid(port), sleep: noSleep })).toBe(true);
  });

  it("does not take another host's answer for a handover", async () => {
    const { port } = await fakeHost(1111); // the predecessor's dying socket or a stale host
    expect(await waitForSuccessor({ childPid: 4242, exited: () => false, answeringPid: () => poolHostPid(port), sleep: noSleep, tries: 5 })).toBe(false);
  });

  it("gives up when the child exits (superseded or crashed at boot)", async () => {
    const { port } = await fakeHost(1111);
    expect(await waitForSuccessor({ childPid: 4242, exited: () => true, answeringPid: () => poolHostPid(port), sleep: noSleep })).toBe(false);
  });

  it("two reloads 1 s apart leave exactly one host answering", async () => {
    // generation 1 reloads into 2, 2 reloads into 3: each handover waits for its own child before the old host is gone
    const port = (await fakeHost(1)).port;
    const handover = async (oldIdx: number, childPid: number): Promise<boolean> => {
      servers[oldIdx]!.close(); // reload: the listener is released for the successor
      await new Promise((r) => setTimeout(r, 20));
      await fakeHost(childPid, port);
      return waitForSuccessor({ childPid, exited: () => false, answeringPid: () => poolHostPid(port), sleep: noSleep });
    };
    expect(await handover(0, 2)).toBe(true);
    expect(await handover(1, 3)).toBe(true);
    expect(await poolHostPid(port)).toBe(3);
  });
});

describe("ensurePoolHost", () => {
  let dir: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pool-heal-"));
    resetPoolHeal();
    prevHome = process.env.HOME;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
  });

  it("restarts a host that died at boot, bounded to one attempt per gap, and logs it", async () => {
    const start = vi.fn(async () => ({ pid: 1, up: false }));
    let t = 1_000_000;
    const deps = { settings: { enabled: true, port: 1 }, probe: async () => "down" as const, start, now: () => t };
    expect(await ensurePoolHost(dir, deps)).toBe(true);
    t += 1000;
    expect(await ensurePoolHost(dir, deps)).toBe(false); // bounded
    t += 61_000;
    expect(await ensurePoolHost(dir, deps)).toBe(true); // retried after the gap
    expect(start).toHaveBeenCalledTimes(2);
    const ledger = join(dir, "ledger.log");
    expect(existsSync(ledger) ? readFileSync(ledger, "utf8") : "").toContain("POOL-HOST-HEAL");
  });

  it("leaves a healthy or reloading host alone", async () => {
    const start = vi.fn(async () => ({ pid: 1, up: true }));
    expect(await ensurePoolHost(dir, { settings: { enabled: true, port: 1 }, probe: async () => "up", start, now: () => 5_000_000 })).toBe(false);
    expect(await ensurePoolHost(dir, { settings: { enabled: true, port: 1 }, probe: async () => "timeout", start, now: () => 9_000_000 })).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
