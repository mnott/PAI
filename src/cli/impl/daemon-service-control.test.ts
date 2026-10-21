/**
 * `pai daemon start|stop`: driven through an injected launchctl runner, never the live service.
 */

import { describe, it, expect } from "vitest";
import { daemonServiceControl, type ServiceControlDeps } from "./daemon.js";

function harness(opts: { installed?: boolean; running: boolean; plat?: NodeJS.Platform; bootstrapOk?: boolean }) {
  const calls: string[] = [];
  const log: string[] = [];
  const errs: string[] = [];
  let running = opts.running;
  const deps: ServiceControlDeps = {
    plat: opts.plat ?? "darwin",
    uid: 501,
    installed: () => opts.installed ?? true,
    pid: () => (running ? 4242 : undefined),
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args[0] === "bootout") running = false;
      if (args[0] === "bootstrap" && opts.bootstrapOk === false) return { status: 5, stderr: "already loaded" };
      if (args[0] === "bootstrap" || args[0] === "kickstart") running = true;
      return { status: 0 };
    },
    sleep: async () => {},
    log: (s) => log.push(s),
    error: (s) => errs.push(s),
    waitMs: 1000,
  };
  return { deps, calls, out: () => log.join("\n"), errs: () => errs.join("\n") };
}

describe("daemonServiceControl", () => {
  it("start when stopped bootstraps the plist and reports running", async () => {
    const h = harness({ running: false });
    expect(await daemonServiceControl("start", h.deps)).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatch(/^launchctl bootstrap gui\/501 .*com\.pai\.pai-daemon\.plist$/);
    expect(h.out()).toContain("Started daemon pid 4242");
  });

  it("start when loaded but idle falls back to kickstart", async () => {
    const h = harness({ running: false, bootstrapOk: false });
    expect(await daemonServiceControl("start", h.deps)).toBe(0);
    expect(h.calls[1]).toBe("launchctl kickstart gui/501/com.pai.pai-daemon");
  });

  it("start when running says so and runs nothing", async () => {
    const h = harness({ running: true });
    expect(await daemonServiceControl("start", h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out()).toContain("already running");
  });

  it("start times out with the log path when the daemon never reports running", async () => {
    const h = harness({ running: false });
    h.deps.run = () => ({ status: 0 });
    expect(await daemonServiceControl("start", h.deps)).toBe(1);
    expect(h.errs()).toContain("did not report running");
    expect(h.errs()).toContain("See ");
  });

  it("stop when running boots the job out (unloads, no uninstall) and notes what stops", async () => {
    const h = harness({ running: true });
    expect(await daemonServiceControl("stop", h.deps)).toBe(0);
    expect(h.calls).toEqual(["launchctl bootout gui/501/com.pai.pai-daemon"]);
    expect(h.out()).toContain("Stopped daemon pid 4242");
    expect(h.out()).toContain("router supervision");
  });

  it("stop when stopped says so and runs nothing", async () => {
    const h = harness({ running: false });
    expect(await daemonServiceControl("stop", h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out()).toContain("not running");
  });

  it("not installed exits 1 and points at install, for start and stop", async () => {
    for (const action of ["start", "stop"] as const) {
      const h = harness({ running: false, installed: false });
      expect(await daemonServiceControl(action, h.deps)).toBe(1);
      expect(h.errs()).toContain("pai daemon install");
      expect(h.calls).toEqual([]);
    }
  });

  it("uses systemctl on linux", async () => {
    const h = harness({ running: true, plat: "linux" });
    h.deps.run = (cmd, args) => {
      h.calls.push([cmd, ...args].join(" "));
      return { status: 0 };
    };
    h.deps.pid = (() => {
      let n = 0;
      return () => (n++ === 0 ? 7 : undefined);
    })();
    expect(await daemonServiceControl("stop", h.deps)).toBe(0);
    expect(h.calls).toEqual(["systemctl --user stop pai-daemon.service"]);
  });
});
