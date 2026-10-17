import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { listenRetry } from "./listen.js";

describe("listenRetry", () => {
  it("listens on a free port", async () => {
    const serverA = createServer();
    await listenRetry(serverA, 0, "127.0.0.1", { waitMs: 0 });
    const port = (serverA.address() as AddressInfo).port;
    serverA.close();

    const serverB = createServer();
    await listenRetry(serverB, port, "127.0.0.1", { waitMs: 0 });
    expect(serverB.listening).toBe(true);
    serverB.close();
  });

  it("rejects with EADDRINUSE when port is busy and waitMs is 0", async () => {
    const serverA = createServer();
    await listenRetry(serverA, 0, "127.0.0.1", { waitMs: 0 });
    const port = (serverA.address() as AddressInfo).port;

    const serverB = createServer();
    await expect(listenRetry(serverB, port, "127.0.0.1", { waitMs: 0 })).rejects.toThrow("EADDRINUSE");
    serverA.close();
  });

  it("waits for a port to become free", async () => {
    const serverA = createServer();
    await listenRetry(serverA, 0, "127.0.0.1", { waitMs: 0 });
    const port = (serverA.address() as AddressInfo).port;

    const serverB = createServer();
    const listenPromise = listenRetry(serverB, port, "127.0.0.1", { waitMs: 3000, intervalMs: 50 });

    setTimeout(() => {
      serverA.close();
    }, 300);

    await listenPromise;
    expect(serverB.listening).toBe(true);
    serverB.close();
  });
});