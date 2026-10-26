import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLocalConfig } from "../../workers/local-tiers.js";
import { readInstances } from "../../workers/local-instances.js";
import { killInstance, portOpen, stopInstance } from "./worker-config.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

/** A "start script": the parent forks a detached child that holds the port (and optionally ignores SIGTERM); the parent stays or exits. */
function fakeServer(dir: string, port: number, opts: { parentExits?: boolean; ignoreTerm?: boolean }): Promise<{ parent: number; child: number }> {
  const child = join(dir, "child.cjs");
  writeFileSync(child, `${opts.ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}require('net').createServer().listen(${port},'127.0.0.1',()=>console.log('up'));setInterval(()=>{},1000);`);
  const parent = join(dir, "parent.cjs");
  writeFileSync(
    parent,
    `const {spawn}=require('child_process');const c=spawn(process.execPath,[${JSON.stringify(child)}],{detached:true,stdio:['ignore','pipe','ignore']});` +
      `c.stdout.once('data',()=>{console.log(JSON.stringify({parent:process.pid,child:c.pid}));${opts.parentExits ? "process.exit(0)" : "c.unref();c.stdout.destroy();setInterval(()=>{},1000)"}});`,
  );
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [parent], { stdio: ["ignore", "pipe", "ignore"] });
    p.on("error", rej);
    p.stdout.once("data", (b) => res(JSON.parse(String(b))));
  });
}

const pids: number[] = [];
afterEach(() => {
  for (const p of pids.splice(0)) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
});

const inst = (port: number, pid?: number) => ({ id: "t#1", model: "t", provider: "tp", url: `http://127.0.0.1:${port}`, origin: "managed" as const, port, ...(pid !== undefined ? { pid } : {}), state: "ready" as const, startedAt: 0, log: "" });

describe("killInstance", () => {
  it("kills a script and the detached child that holds the port, and the port is closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-"));
    const port = await freePort();
    const { parent, child } = await fakeServer(dir, port, {});
    pids.push(parent, child);
    expect(await portOpen(port)).toBe(true);
    await killInstance(inst(port, parent), portOpen, 3000);
    expect(await portOpen(port)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect([alive(parent), alive(child)]).toEqual([false, false]);
  });

  it("kills the port's listener when the recorded pid is the script that already exited (or unknown)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-"));
    const port = await freePort();
    const { parent, child } = await fakeServer(dir, port, { parentExits: true });
    pids.push(child);
    await killInstance(inst(port, parent), portOpen, 3000);
    expect(await portOpen(port)).toBe(false);
    expect(alive(child)).toBe(false);
    const port2 = await freePort();
    const b = await fakeServer(mkdtempSync(join(tmpdir(), "pai-kill-")), port2, { parentExits: true });
    pids.push(b.child);
    await killInstance(inst(port2), portOpen, 3000);
    expect(await portOpen(port2)).toBe(false);
  });

  it("escalates to SIGKILL when the server ignores SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-kill-"));
    const port = await freePort();
    const { parent, child } = await fakeServer(dir, port, { ignoreTerm: true });
    pids.push(parent, child);
    await killInstance(inst(port, parent), portOpen, 600);
    expect(await portOpen(port)).toBe(false);
  });

  it("stopInstance with the default kill removes the row only after the port is closed", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-kill-"));
    const port = await freePort();
    const { parent, child } = await fakeServer(d, port, {});
    pids.push(parent, child);
    const cfg = parseLocalConfig({ local_tiers: { t: { engine: "script", provider: "tp", start: "/x.sh", port } } }, { tp: { model: "m" } });
    const live = [{ pid: parent, rssKb: 1, port, tier: "t", provider: "tp" }];
    const done = await stopInstance(cfg, "tp", {}, { ledger: join(d, "l"), startDir: d, servers: () => live, up: portOpen });
    expect(done.map((i) => i.id)).toEqual(["t#1"]);
    expect(await portOpen(port)).toBe(false);
    expect(readInstances(d)).toEqual([]);
  });
});
