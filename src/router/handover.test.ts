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

describe("handover with a long in-flight stream", () => {
  it("new router serves at once, the old stream completes on the old process, the drain max ends leftovers with an SSE error", async () => {
    const { trackInflight } = await import("./inflight.js");
    const inflight = trackInflight();
    let finishLong: (() => void) | undefined;
    const old = http.createServer(
      inflight.wrap((req, res) => {
        if (req.url === "/long") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: start\n\n");
          finishLong = () => res.end("data: done\n\n");
          return;
        }
        res.end("old");
      })
    );
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
    const port = (old.address() as net.AddressInfo).port;

    const read = (path: string) =>
      new Promise<string>((res, rej) => {
        http.get({ host: "127.0.0.1", port, path, agent: false }, (r) => {
          let b = "";
          r.on("data", (c) => (b += c));
          r.on("end", () => res(b));
          r.on("error", rej);
        }).on("error", rej);
      });
    const long = read("/long");
    await sleep(100);
    expect(inflight.count()).toBe(1);

    const dir = mkdtempSync(join(tmpdir(), "handover-"));
    const script = join(dir, "successor.cjs");
    writeFileSync(script, SUCCESSOR);
    const fd = (old as unknown as { _handle: { fd: number } })._handle.fd;
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "inherit", "inherit", fd, "ipc"] });
    await new Promise<void>((res, rej) => {
      child.once("message", () => res());
      child.once("exit", () => rej(new Error("successor exited")));
    });
    // old stops accepting but is not done: drain waits on the stream
    let drained = false;
    const drain = drainServers([old], { timeoutMs: 5000, idleGraceMs: 100 }).then(() => (drained = true));
    await sleep(200);
    const t0 = Date.now();
    expect(await read("/")).toBe("new");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(drained).toBe(false);
    finishLong?.();
    expect(await long).toBe("data: start\n\ndata: done\n\n");
    await drain;
    child.send("stop");
    await new Promise((r) => child.once("exit", r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("the drain max ends an unfinished stream with a clean SSE error", async () => {
    const { trackInflight } = await import("./inflight.js");
    const inflight = trackInflight();
    const old = http.createServer(
      inflight.wrap((_q, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: start\n\n");
      })
    );
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
    const port = (old.address() as net.AddressInfo).port;
    const body = new Promise<string>((res, rej) => {
      http.get({ host: "127.0.0.1", port, agent: false }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => res(b));
      }).on("error", rej);
    });
    await sleep(100);
    const t0 = Date.now();
    await drainServers([old], { timeoutMs: 300, onTimeout: () => inflight.endAll("router restarted, retry the request") });
    const text = await body;
    expect(text).toContain("event: error");
    expect(text).toContain("retry the request");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("startHandover fails fast with the reason when the successor died", async () => {
    const dir = mkdtempSync(join(tmpdir(), "handover-"));
    const prev = process.env.PAI_HOME;
    process.env.PAI_HOME = dir;
    try {
      const { routerHandoverFile, routerHandoverStatusFile } = await import("./supervisor.js");
      const proc = spawn(process.execPath, ["-e", "process.on('SIGUSR2',()=>{});setTimeout(()=>{},5000)"]);
      await sleep(200);
      writeFileSync(routerHandoverFile(), String(proc.pid));
      const p = startHandover(proc.pid!)!;
      writeFileSync(routerHandoverStatusFile(), JSON.stringify({ oldPid: proc.pid, state: "failed", reason: "successor exited before taking over" }));
      await expect(p).rejects.toThrow(/kept serving: successor exited/);
      proc.kill();
    } finally {
      if (prev === undefined) delete process.env.PAI_HOME;
      else process.env.PAI_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
