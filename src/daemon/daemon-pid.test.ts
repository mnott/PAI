import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDaemonPid, pidfilePid, parseLaunchctlPid, parseSystemdMainPid } from "./daemon-pid.js";

const LAUNCHCTL = `gui/501/com.pai.pai-daemon = {
\tactive count = 1
\tstate = running
\tprogram = /usr/local/bin/node
\tpid = 21198
\timmediate reason = ipc (mach)
}`;
const LAUNCHCTL_STOPPED = `gui/501/com.pai.pai-daemon = {\n\tstate = waiting\n\tlast exit code = 0\n}`;

const ok = (stdout: string) => ({ status: 0, stdout });
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function pidfile(content: string, mtime: Date): string {
  const d = mkdtempSync(join(tmpdir(), "pai-pid-"));
  dirs.push(d);
  const p = join(d, "daemon.pid");
  writeFileSync(p, content);
  utimesSync(p, mtime, mtime);
  return p;
}

describe("resolveDaemonPid", () => {
  it("darwin: reads pid from launchctl print", () => {
    const calls: string[][] = [];
    const sh = (cmd: string, args: string[]) => (calls.push([cmd, ...args]), ok(LAUNCHCTL));
    expect(resolveDaemonPid("darwin", sh, "/nonexistent/daemon.pid")).toBe(21198);
    expect(calls[0].slice(0, 2)).toEqual(["launchctl", "print"]);
    expect(calls[0][2]).toMatch(/^gui\/\d+\/com\.pai\.pai-daemon$/);
  });

  it("darwin: stopped job with no pidfile is undefined", () => {
    expect(resolveDaemonPid("darwin", () => ok(LAUNCHCTL_STOPPED), "/nonexistent/daemon.pid")).toBeUndefined();
  });

  it("linux: reads MainPID from systemctl show", () => {
    const calls: string[][] = [];
    const sh = (cmd: string, args: string[]) => (calls.push([cmd, ...args]), ok("MainPID=4711\n"));
    expect(resolveDaemonPid("linux", sh, "/nonexistent/daemon.pid")).toBe(4711);
    expect(calls[0]).toEqual(["systemctl", "--user", "show", "-p", "MainPID", "pai-daemon.service"]);
  });

  it("linux: MainPID=0 falls back to a valid pidfile", () => {
    const p = pidfile("777\n", new Date());
    const sh = (cmd: string) =>
      cmd === "systemctl" ? ok("MainPID=0\n") : ok(new Date(Date.now() - 60_000).toString());
    expect(resolveDaemonPid("linux", sh, p)).toBe(777);
  });
});

describe("parsers", () => {
  it("parse launchctl and systemd output", () => {
    expect(parseLaunchctlPid(LAUNCHCTL)).toBe(21198);
    expect(parseLaunchctlPid(LAUNCHCTL_STOPPED)).toBeUndefined();
    expect(parseSystemdMainPid("MainPID=0")).toBeUndefined();
  });
});

describe("pidfilePid", () => {
  const psAt = (t: Date) => () => ok(t.toString());

  it("accepts a process that started before the pidfile was written", () => {
    const now = Date.now();
    const p = pidfile("123\n", new Date(now));
    expect(pidfilePid(p, psAt(new Date(now - 5000)))).toBe(123);
  });

  it("rejects a reused pid (process started after the pidfile)", () => {
    const now = Date.now();
    const p = pidfile("123\n", new Date(now - 3_600_000));
    expect(pidfilePid(p, psAt(new Date(now - 60_000)))).toBeUndefined();
  });

  it("rejects a dead pid, a garbage file and a missing file", () => {
    const p = pidfile("123\n", new Date());
    expect(pidfilePid(p, () => ({ status: 1, stdout: "" }))).toBeUndefined();
    expect(pidfilePid(pidfile("junk", new Date()), psAt(new Date(0)))).toBeUndefined();
    expect(pidfilePid("/nonexistent/daemon.pid")).toBeUndefined();
  });
});

describe("no pattern-based process lookup", () => {
  it("src/cli and src/daemon contain no pgrep -f / pkill", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const f = join(d, n);
        return statSync(f).isDirectory() ? walk(f) : f.endsWith(".ts") && !f.endsWith(".test.ts") ? [f] : [];
      });
    const root = join(__dirname, "..");
    const hits = [...walk(join(root, "cli")), ...walk(join(root, "daemon"))].filter((f) =>
      /pgrep["',\s]+\[?\s*["']-f|pkill/.test(readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });
});
