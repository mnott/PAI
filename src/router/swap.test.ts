import { describe, it, expect } from "vitest";
import http from "node:http";
import net from "node:net";
import { drainServers } from "./drain.js";
import { listenRetry } from "./listen.js";
import { restartRouter } from "./restart.js";
import { routerSwapArgs } from "./supervisor.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WARM_MS = 300;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return p;
}

/** One swap, driven through restartRouter: the new router warms up for WARM_MS, the old drains and exits, the new takes the port. */
async function swap(): Promise<{ refusedMs: number; newListening: number; oldExited: number }> {
  const port = await freePort();
  let draining = false;
  const serving: http.RequestListener = (_q, res) => {
    if (draining) res.setHeader("Connection", "close");
    res.end("ok");
  };
  const oldServer = http.createServer(serving);
  await listenRetry(oldServer, port, "127.0.0.1", { waitMs: 0 });

  const stopOld = async () => {
    draining = true;
    await drainServers([oldServer], { timeoutMs: 2000, idleGraceMs: 50 });
    oldExited = Date.now();
  };
  let oldExited = 0;
  let newListening = 0;
  const newServer = http.createServer(serving);

  // client probing the port every 2 ms; a refused connect is a dark port
  let stop = false;
  let refusedMs = 0;
  let darkSince = 0;
  const prober = (async () => {
    while (!stop) {
      const up = await new Promise<boolean>((res) => {
        const s = net.connect({ host: "127.0.0.1", port });
        s.once("connect", () => { s.destroy(); res(true); });
        s.once("error", () => res(false));
      });
      const t = Date.now();
      if (!up && !darkSince) darkSince = t;
      if (up && darkSince) { refusedMs = Math.max(refusedMs, t - darkSince); darkSince = 0; }
      await sleep(2);
    }
  })();

  const warmedAndListening = (async () => {
    await sleep(WARM_MS); // the new router builds its state first
    return undefined;
  })();

  const spawnNew = (old: number | undefined): number => {
    void (async () => {
      await warmedAndListening;
      // what `router run --replace` does once warm: stop the old router, bind the moment the port frees
      if (old !== undefined) void stopOld();
      await listenRetry(newServer, port, "127.0.0.1", { waitMs: 5000, intervalMs: 1 });
      newListening = Date.now();
    })();
    return 2;
  };
  // the pre-42a28287 contract: restartRouter signalled the old router right at spawn
  const legacy = { signalOld: () => void stopOld() };

  await restartRouter({ oldPid: 1, spawnNew, ...legacy, isUp: async () => newListening > 0, pollMs: 5 } as never);
  await sleep(100);
  stop = true;
  await prober;
  await new Promise((r) => newServer.close(r));
  return { refusedMs, newListening, oldExited };
}

describe("router swap", () => {
  it("asks the new router to replace the old one", () => {
    expect(routerSwapArgs(4242)).toEqual(["--wait-bind", "10", "--replace", "4242"]);
    expect(routerSwapArgs(undefined)).toEqual(["--wait-bind", "10"]);
  });

  it("keeps the port open through the new router's warm-up, and the old one exits only once the new one listens", async () => {
    const r = await swap();
    expect(r.refusedMs).toBeLessThan(WARM_MS / 3);
    expect(r.newListening).toBeGreaterThan(0);
    expect(r.oldExited).toBeGreaterThanOrEqual(r.newListening);
  });

  it("a draining router tells keep-alive clients to reconnect", async () => {
    const port = await freePort();
    let draining = false;
    const server = http.createServer((_q, res) => {
      if (draining) res.setHeader("Connection", "close");
      res.end("ok");
    });
    await listenRetry(server, port, "127.0.0.1", { waitMs: 0 });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = () => new Promise<http.IncomingMessage>((res) => http.get({ host: "127.0.0.1", port, agent }, (m) => { m.resume(); m.on("end", () => res(m)); }));
    expect((await get()).headers.connection).toBe("keep-alive");
    draining = true;
    expect((await get()).headers.connection).toBe("close");
    agent.destroy();
    await new Promise((r) => server.close(r));
  });
});
