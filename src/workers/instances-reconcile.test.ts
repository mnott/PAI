import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEndpointHealth, probeEndpointUrl } from "./endpoint-health.js";
import { readLiveInstances, writeInstances, type LocalInstance } from "./local-instances.js";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.close();
});

const up = (): boolean => true;
const row = (pid: number, port: number): LocalInstance => ({
  id: "fake#1", model: "fake", provider: "fake", url: `http://127.0.0.1:${port}`, origin: "managed", port, pid, state: "ready", startedAt: 0, log: "",
});

describe("instance records follow the processes", () => {
  it("drops a managed instance whose process was killed outside the pool on the next read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inst-"));
    dirs.push(dir);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    writeInstances(dir, [row(child.pid!, 59999)]);
    expect(readLiveInstances(dir, up)).toHaveLength(1);
    const gone = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await gone;
    expect(readLiveInstances(dir, up)).toHaveLength(0);
  });

  it("keeps a failed row and a row without a pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "inst-"));
    dirs.push(dir);
    const dead = 2 ** 22 - 1;
    writeInstances(dir, [{ ...row(dead, 1), state: "failed" }, { ...row(0, 2), id: "fake#2", pid: undefined }]);
    expect(readLiveInstances(dir, up).map((r) => r.id)).toEqual(["fake#1", "fake#2"]);
  });
});

describe("managed health is a fresh probe", () => {
  it("turns unhealthy within the bound once the listener stops answering", async () => {
    const srv = createServer((_q, res) => res.end("{}"));
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    let t = 0;
    const h = createEndpointHealth({ probe: (u) => probeEndpointUrl(u, 500), intervalMs: 10_000, now: () => t });
    const inst = row(process.pid, port);
    await h.refreshManaged([inst]);
    expect(h.isHealthy(inst)).toBe(true);
    await new Promise((r) => srv.close(r));
    t = 10_001;
    await h.refreshManaged([inst]);
    expect(h.isHealthy(inst)).toBe(false);
  });

  it("a probe older than two intervals no longer vouches for the port", async () => {
    let t = 0;
    const h = createEndpointHealth({ probe: async () => true, intervalMs: 100, now: () => t });
    const inst = row(process.pid, 1);
    await h.refreshManaged([inst]);
    expect(h.isHealthy(inst)).toBe(true);
    t = 250;
    expect(h.isHealthy(inst)).toBe(false);
  });
});
