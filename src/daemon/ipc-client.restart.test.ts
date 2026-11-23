import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaiClient } from "./ipc-client.js";

const servers: Server[] = [];
const socks: Socket[] = [];
let dir = "";
afterEach(() => {
  for (const s of socks.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function listen(path: string, onLine: (line: string, sock: Socket) => void): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((sock) => {
      socks.push(sock);
      let buf = "";
      sock.on("data", (c) => {
        buf += c.toString();
        const nl = buf.indexOf("\n");
        if (nl >= 0) { onLine(buf.slice(0, nl), sock); buf = ""; }
      });
      sock.on("error", () => {});
    });
    servers.push(srv);
    srv.listen(path, () => resolve(srv));
  });
}
const answer = (line: string, sock: Socket) => {
  const r = JSON.parse(line) as { id: string };
  sock.write(JSON.stringify({ id: r.id, ok: true, result: { uptime: 1, via: "new" } }) + "\n");
  sock.end();
};

describe("PaiClient daemon restart", () => {
  it("server killed mid-request, new server up: answer comes from the new server", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-ipc-"));
    const path = join(dir, "s.sock");
    const old = await listen(path, () => { /* never answers */ });
    const t0 = Date.now();
    const p = new PaiClient(path).call("code_search", { query: "x" });
    await new Promise((r) => setTimeout(r, 300));
    for (const s of socks.splice(0)) s.destroy();
    old.close();
    if (existsSync(path)) unlinkSync(path);
    await new Promise((r) => setTimeout(r, 600));
    await listen(path, answer);
    expect(((await p) as { via: string }).via).toBe("new");
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("old process accepts but never answers, socket unlinked: retried, answered by new", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-ipc-"));
    const path = join(dir, "s.sock");
    await listen(path, () => {});
    const t0 = Date.now();
    const p = new PaiClient(path).call("code_search", { query: "x" });
    await new Promise((r) => setTimeout(r, 300));
    unlinkSync(path);
    await listen(path, answer);
    expect(((await p) as { via: string }).via).toBe("new");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("restarting error from the old daemon is retried", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-ipc-"));
    const path = join(dir, "s.sock");
    let n = 0;
    await listen(path, (line, sock) => {
      const r = JSON.parse(line) as { id: string };
      if (n++ < 2) sock.write(JSON.stringify({ id: r.id, ok: false, error: "PAI daemon is restarting (shutting down); retry" }) + "\n");
      else answer(line, sock);
    });
    expect(((await new PaiClient(path).call("x", {})) as { via: string }).via).toBe("new");
    expect(n).toBe(3);
  });

  it("daemon stays down: clear restarting error within the window, not 60 s", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-ipc-"));
    const t0 = Date.now();
    await expect(new PaiClient(join(dir, "none.sock"), { restartWindowMs: 1500 }).call("code_search", {}))
      .rejects.toThrow(/PAI daemon is restarting \(or down\): socket missing/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
  it("read-only method dropped mid-flight is retried and answered", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-ipc-"));
    const path = join(dir, "s.sock");
    let n = 0;
    await listen(path, (line, sock) => { if (n++ === 0) sock.destroy(); else answer(line, sock); });
    expect(((await new PaiClient(path).call("memory_search", {})) as { via: string }).via).toBe("new");
    expect(n).toBe(2);
  });

  it("mutating method dropped mid-flight is not retried and gets a clear error", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-ipc-"));
    const path = join(dir, "s.sock");
    let n = 0;
    await listen(path, (line, sock) => { if (n++ === 0) sock.destroy(); else answer(line, sock); });
    await expect(new PaiClient(path).call("work_queue_enqueue", {}))
      .rejects.toThrow(/restarted while handling work_queue_enqueue; it may or may not have run/);
    expect(n).toBe(1);
  });

  it("mutating method refused at connect is retried", async () => {
    dir = mkdtempSync(join(tmpdir(), "pai-ipc-"));
    const path = join(dir, "s.sock");
    const p = new PaiClient(path).call("work_queue_enqueue", {});
    await new Promise((r) => setTimeout(r, 400));
    await listen(path, answer);
    expect(((await p) as { via: string }).via).toBe("new");
  });
});
