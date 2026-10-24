import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameReader, OwnedProc, exitFilePath, frame, paneExecDir, listRecords, openOwnedPane, paneExecCommand, pidAlive, runPaneExec, sockPath, type ExecDeps, type OwnedPane } from "./pane-exec.js";
import { launchPane, noTerminalReasons } from "./pane-launch.js";
import { NoTerminalError } from "./pane.js";
import { defaultWorkersConfig } from "./config.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-pexec-"));
  vi.stubEnv("PAI_HOME", join(dir, "home"));
  vi.stubEnv("PAI_WORKER_ALLOW_HIDDEN", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  events: string[];
  shown: string[];
  wrapper: Promise<number>;
  pane: Promise<OwnedPane>;
}

/** The pane opener seam: "opening the pane" runs the wrapper in-process, the way iTerm would run it in a pane. */
function rig(id: string, deps: Partial<ExecDeps> = {}): Rig {
  const r = { events: [] as string[], shown: [] as string[] } as Rig;
  r.pane = openOwnedPane({
    id,
    kind: "pane",
    open: async (command) => {
      r.events.push("pane-open");
      expect(command).toContain(`pane exec ${id}`);
      r.wrapper = runPaneExec(id, {
        out: (s) => r.shown.push(String(s)),
        err: (s) => r.shown.push(String(s)),
        closePane: async () => void r.events.push("pane-close"),
        proc: new EventEmitter() as NodeJS.Process,
        killGraceMs: 300,
        linger: 0,
        ...deps,
      });
      return "fake pane";
    },
    helloMs: 5000,
  });
  return r;
}

const closed = (p: OwnedProc): Promise<number> => new Promise((res) => p.on("close", (c: number) => res(c)));

describe("the pane owns the process", () => {
  it("opens the pane before the child starts, runs the child under the wrapper, propagates the exit code, writes the exit file, closes the pane", async () => {
    const marker = join(dir, "started");
    const r = rig("t-order");
    const pane = await r.pane;
    r.events.push("pane-ready");
    const proc = await pane.start({ argv: ["sh", "-c", `echo started > ${marker}; echo hello; exit 3`], render: "plain", stdin: "ignore" });
    r.events.push("child-started");
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c));
    expect(await closed(proc)).toBe(3);
    expect(out).toContain("hello");
    expect(await r.wrapper).toBe(3);
    // order: the pane was open, and the wrapper connected, before the child ran
    expect(r.events.slice(0, 3)).toEqual(["pane-open", "pane-ready", "child-started"]);
    expect(r.events.at(-1)).toBe("pane-close");
    const ex = JSON.parse(readFileSync(exitFilePath("t-order"), "utf8"));
    expect(ex.code).toBe(3);
    expect(ex.endedMs).toBeGreaterThan(0);
    // the pane showed the child's output and the exit footer
    expect(r.shown.join("")).toContain("hello");
    expect(r.shown.join("")).toContain("[exit 3");
    expect(proc.pid).toBeGreaterThan(0);
    expect(listRecords().find((x) => x.id === "t-order")?.child).toBe(proc.pid);
  }, 15_000);

  it("the child sees its pane-exec id in the environment", async () => {
    const r = rig("t-env");
    const proc = await (await r.pane).start({ argv: ["sh", "-c", "echo $PAI_PANE_EXEC"], env: { PATH: process.env.PATH } });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c));
    await closed(proc);
    await r.wrapper;
    expect(out.trim()).toBe("t-env");
  }, 15_000);

  it("the child keeps USER/LOGNAME/HOME even when the start spec's env lacks them", async () => {
    // a spec env replaces process.env entirely; Claude Code names its keychain
    // OAuth account by USER/LOGNAME, so the wrapper must fill them back in
    const r = rig("t-identity");
    const proc = await (await r.pane).start({ argv: ["sh", "-c", 'echo "$USER|$LOGNAME|$HOME"'], env: { PATH: process.env.PATH } });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c));
    await closed(proc);
    await r.wrapper;
    const [user, logname, home] = out.trim().split("|");
    expect(user).toBeTruthy();
    expect(logname).toBeTruthy();
    expect(home).toBeTruthy();
  }, 15_000);

  it("a child that crashes ends the wrapper with a nonzero code and the pane closes", async () => {
    const r = rig("t-crash");
    const proc = await (await r.pane).start({ argv: ["sh", "-c", "kill -9 $$"] });
    const code = await closed(proc);
    expect(code).toBeGreaterThan(0);
    expect(await r.wrapper).toBe(code);
    expect(r.events).toContain("pane-close");
    expect(JSON.parse(readFileSync(exitFilePath("t-crash"), "utf8")).code).toBe(code);
  }, 15_000);

  it("a command that cannot start fails the start and closes the pane", async () => {
    const r = rig("t-enoent");
    await expect((await r.pane).start({ argv: ["/nonexistent/pai-test-bin"] })).rejects.toThrow();
    expect(await r.wrapper).toBe(127);
    expect(r.events).toContain("pane-close");
  }, 15_000);

  it("kill from the caller reaches the child's process group", async () => {
    const r = rig("t-kill");
    const proc = await (await r.pane).start({ argv: ["sh", "-c", "sleep 60 & wait"] });
    const pid = proc.pid!;
    proc.kill("SIGTERM");
    expect(await closed(proc)).toBeGreaterThan(0);
    await r.wrapper;
    expect(pidAlive(pid)).toBe(false);
  }, 15_000);

  it("stdin and stdout relay through the wrapper", async () => {
    const r = rig("t-relay");
    const proc = await (await r.pane).start({ argv: ["cat"], stdin: "pipe" });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c));
    proc.stdin!.write("ping\n");
    proc.stdin!.end();
    expect(await closed(proc)).toBe(0);
    expect(out).toBe("ping\n");
    await r.wrapper;
  }, 15_000);

  it("stream mode renders claude stream-json in the pane while the caller gets the raw stream", async () => {
    const r = rig("t-stream");
    const ev = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "rendered words" }] } });
    const proc = await (await r.pane).start({ argv: ["sh", "-c", `echo '${ev}'`], render: "stream" });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c));
    await closed(proc);
    await r.wrapper;
    expect(out).toBe(ev + "\n");
    const shown = r.shown.join("");
    expect(shown).toContain("rendered words");
    expect(shown).not.toContain('"type":"assistant"');
  }, 15_000);

  it("a cancelled pane closes without running anything", async () => {
    const r = rig("t-cancel");
    (await r.pane).cancel();
    expect(await r.wrapper).toBe(0);
    expect(r.events).toContain("pane-close");
    expect(JSON.parse(readFileSync(exitFilePath("t-cancel"), "utf8")).cancelled).toBe(true);
  }, 15_000);

  it("a pane close that never answers does not keep the wrapper alive", async () => {
    const id = "t-hang";
    mkdirSync(paneExecDir(), { recursive: true });
    const server = createServer();
    const sockets = new Promise<import("node:net").Socket>((res) => server.once("connection", res));
    await new Promise<void>((res) => server.listen(sockPath(id), res));
    const wrapper = runPaneExec(id, { out: () => undefined, err: () => undefined, closePane: () => new Promise<void>(() => undefined), proc: new EventEmitter() as NodeJS.Process, killGraceMs: 300, linger: 0 });
    const s = await sockets;
    s.write(frame("S", JSON.stringify({ argv: ["true"] })));
    const t0 = Date.now();
    expect(await wrapper).toBe(0);
    server.close();
    expect(Date.now() - t0).toBeLessThan(9000);
  }, 15_000);

  it("the hello carries the iTerm session only outside tmux", async () => {
    const hello = async (id: string, env: NodeJS.ProcessEnv): Promise<{ session?: string }> => {
      mkdirSync(paneExecDir(), { recursive: true });
      const server = createServer();
      const got = new Promise<{ session?: string }>((res) => server.once("connection", (s) => {
        const rd = new FrameReader();
        s.on("data", (c: Buffer) => { for (const f of rd.push(c)) if (f.t === "H") { res(JSON.parse(f.p.toString())); s.write(frame("S", JSON.stringify({ argv: ["true"] }))); } });
      }));
      await new Promise<void>((res) => server.listen(sockPath(id), res));
      const w = runPaneExec(id, { out: () => undefined, err: () => undefined, closePane: async () => undefined, proc: new EventEmitter() as NodeJS.Process, env, linger: 0 });
      const h = await got;
      await w;
      server.close();
      return h;
    };
    expect((await hello("t-h1", { ITERM_SESSION_ID: "w0t0p0:ABC" })).session).toBe("w0t0p0:ABC");
    expect((await hello("t-h2", { ITERM_SESSION_ID: "w0t0p0:ABC", TMUX: "/tmp/tmux-1/default,1,0" })).session).toBeUndefined();
    expect((await hello("t-h3", { ITERM_SESSION_ID: "" })).session).toBeUndefined();
  }, 15_000);

  it("the caller going away kills the child and closes the pane", async () => {
    const id = "t-gone";
    const closes: string[] = [];
    mkdirSync(paneExecDir(), { recursive: true });
    const server = createServer();
    const sockets = new Promise<import("node:net").Socket>((res) => server.once("connection", res));
    await new Promise<void>((res) => server.listen(sockPath(id), res));
    const wrapper = runPaneExec(id, { out: () => undefined, err: () => undefined, closePane: async () => void closes.push("closed"), proc: new EventEmitter() as NodeJS.Process, killGraceMs: 300, linger: 0 });
    const s = await sockets;
    const rd = new FrameReader();
    const pid = await new Promise<number>((res) => {
      s.on("data", (c: Buffer) => {
        for (const f of rd.push(c)) if (f.t === "P") res(JSON.parse(f.p.toString()).pid);
      });
      s.write(frame("S", JSON.stringify({ argv: ["sleep", "60"] })));
    });
    expect(pidAlive(pid)).toBe(true);
    s.destroy(); // the caller was killed
    const code = await wrapper;
    server.close();
    expect(code).toBeGreaterThan(0);
    expect(pidAlive(pid)).toBe(false);
    expect(closes).toEqual(["closed"]);
    expect(JSON.parse(readFileSync(exitFilePath(id), "utf8")).reason).toBe("caller gone");
  }, 15_000);

  it("the terminal going away (SIGHUP) does not kill the command; SIGTERM still does", async () => {
    const run = async (id: string, sig: NodeJS.Signals, argv: string[]): Promise<{ code: number; reason?: string; alive: boolean }> => {
      mkdirSync(paneExecDir(), { recursive: true });
      const server = createServer();
      const sockets = new Promise<import("node:net").Socket>((res) => server.once("connection", res));
      await new Promise<void>((res) => server.listen(sockPath(id), res));
      const proc = new EventEmitter() as NodeJS.Process;
      const wrapper = runPaneExec(id, { out: () => undefined, err: () => undefined, closePane: async () => undefined, proc, killGraceMs: 300, linger: 0 });
      const s = await sockets;
      const rd = new FrameReader();
      const pid = await new Promise<number>((res) => {
        s.on("data", (c: Buffer) => { for (const f of rd.push(c)) if (f.t === "P") res(JSON.parse(f.p.toString()).pid); });
        s.write(frame("S", JSON.stringify({ argv })));
      });
      proc.emit(sig, sig);
      await new Promise((r) => setTimeout(r, 200));
      const alive = pidAlive(pid);
      const code = await wrapper;
      server.close();
      return { code, reason: JSON.parse(readFileSync(exitFilePath(id), "utf8")).reason, alive };
    };
    const hup = await run("t-hup", "SIGHUP", ["sh", "-c", "sleep 1; exit 0"]);
    expect(hup).toEqual({ code: 0, reason: undefined, alive: true });
    const term = await run("t-term", "SIGTERM", ["sleep", "60"]);
    expect(term.reason).toBe("pane closed");
    expect(term.alive).toBe(false);
  }, 20_000);

  it("a wrapper that never connects fails the open and closes the pane again", async () => {
    const closeFailed = vi.fn(async () => true);
    await expect(openOwnedPane({ id: "t-nohello", kind: "pane", open: async () => "pane", closeFailed, helloMs: 200 })).rejects.toThrow(/did not connect/);
    expect(closeFailed).toHaveBeenCalled();
    expect(existsSync(sockPath("t-nohello"))).toBe(false);
  });

  it("the pane command is one exec-able line naming the wrapper", () => {
    expect(paneExecCommand("abc", "/n/node", "/x/cli/index.mjs")).toBe("/n/node /x/cli/index.mjs pane exec abc");
  });
});

describe("launchPane", () => {
  const base = { logDir: "", config: defaultWorkersConfig(), term: "", kind: "pane" as const };
  it("no terminal at all: resolves to null (the command runs directly) and records it", async () => {
    const logDir = join(dir, "logs");
    const p = await launchPane({ ...base, logDir, id: "t-noterm", env: {}, open: async () => { throw new NoTerminalError("neither TMUX nor ITERM_SESSION_ID"); } });
    expect(p).toBeNull();
    expect(noTerminalReasons.get("t-noterm")).toBe("no terminal");
    expect(readFileSync(join(logDir, "ledger.log"), "utf8")).toContain("PANE-NOTERMINAL");
  });
  it("any other failure to open the pane rejects: the command does not run unseen", async () => {
    await expect(launchPane({ ...base, logDir: join(dir, "logs"), id: "t-fail", env: {}, open: async () => { throw new Error("split failed"); } })).rejects.toThrow("split failed");
  });
  it("the operator's hidden-run override runs directly", async () => {
    const p = await launchPane({ ...base, logDir: join(dir, "logs"), id: "t-allow", env: { PAI_WORKER_ALLOW_HIDDEN: "1" }, open: async () => { throw new Error("must not open"); } });
    expect(p).toBeNull();
  });
});
