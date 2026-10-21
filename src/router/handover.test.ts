import { describe, it, expect } from "vitest";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainServers } from "./drain.js";
import { startHandover } from "./supervisor.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// the successor: serves on the inherited listening socket (fd 3) and reports ready over IPC, as `pai router run --inherit-fds 3` does
const SUCCESSOR = `
const http = require("node:http");
const s = http.createServer((q, r) => r.end("new"));
s.listen({ fd: 3 }, () => process.send({ ready: true }));
process.on("message", (m) => { if (m === "stop") process.exit(0); });
`;

describe("listening-socket handover", () => {
  it("hammering clients see no error while the old server hands its socket over and drains", async () => {
    const dir = mkdtempSync(join(tmpdir(), "handover-"));
    const script = join(dir, "successor.cjs");
    writeFileSync(script, SUCCESSOR);
    let draining = false;
    const old = http.createServer((_q, r) => {
      if (draining) r.setHeader("Connection", "close");
      r.end("old");
    });
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
    const port = (old.address() as net.AddressInfo).port;

    let stop = false;
    const errors: string[] = [];
    const served: Record<string, number> = {};
    const clients = [0, 1, 2, 3].map(async () => {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      while (!stop) {
        await new Promise<void>((res) => {
          http
            .get({ host: "127.0.0.1", port, agent, timeout: 3000 }, (r) => {
              let b = "";
              r.on("data", (c) => (b += c));
              r.on("end", () => {
                served[b] = (served[b] ?? 0) + 1;
                res();
              });
            })
            .on("error", (e: NodeJS.ErrnoException) => {
              errors.push(e.code ?? e.message);
              res();
            });
        });
        await sleep(2);
      }
      agent.destroy();
    });
    await sleep(100);

    const fd = (old as unknown as { _handle: { fd: number } })._handle.fd;
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "inherit", "inherit", fd, "ipc"] });
    await new Promise<void>((res, rej) => {
      child.once("message", () => res());
      child.once("exit", () => rej(new Error("successor exited")));
    });
    draining = true;
    await drainServers([old], { timeoutMs: 5000, idleGraceMs: 500 });
    expect(old.listening).toBe(false);
    await sleep(200);
    stop = true;
    await Promise.all(clients);
    child.send("stop");
    await new Promise((r) => child.once("exit", r));
    rmSync(dir, { recursive: true, force: true });

    expect(errors).toEqual([]);
    expect(served.old).toBeGreaterThan(0);
    expect(served.new).toBeGreaterThan(0);
  });

  it("startHandover refuses a router that did not announce handover support", () => {
    expect(startHandover(process.pid)).toBeNull();
  });
});
