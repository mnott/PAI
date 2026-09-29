import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: "", stderr: "" })));
const home = vi.hoisted(() => ({ current: "/real/home" }));

vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), spawnSync: spawn }));
vi.mock("node:os", async (orig) => {
  const os = await orig<typeof import("node:os")>();
  return { ...os, homedir: () => home.current, userInfo: () => ({ ...os.userInfo(), homedir: "/real/home" }) };
});

import { serviceManagerAllowed } from "./service-manager.js";

afterEach(() => {
  spawn.mockClear();
  vi.restoreAllMocks();
});

describe("serviceManagerAllowed", () => {
  it("foreign HOME: refuses and prints the manual command", () => {
    home.current = "/tmp/other";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(serviceManagerAllowed("launchctl load /x.plist")).toBe(false);
    expect(log.mock.calls[0][0]).toContain("service not (re)loaded because HOME is not the account home");
    expect(log.mock.calls[0][0]).toContain("launchctl load /x.plist");
  });

  it("matching HOME: allows, prints nothing", () => {
    home.current = "/real/home";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(serviceManagerAllowed("x")).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("installSchedule / uninstallSchedule (darwin)", () => {
  const run = async (h: string) => {
    home.current = h;
    vi.resetModules();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("node:fs", async (orig) => ({
      ...(await orig<typeof import("node:fs")>()),
      existsSync: () => true,
      mkdirSync: () => undefined,
      writeFileSync: () => undefined,
      unlinkSync: () => undefined,
    }));
    const m = await import("./tasks/schedule-install.js");
    m.installSchedule();
    m.uninstallSchedule();
  };

  it("foreign HOME: no launchctl call", async () => {
    await run("/tmp/other");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("matching HOME: launchctl called", async () => {
    await run("/real/home");
    expect(spawn.mock.calls.some((c) => (c as unknown[])[0] === "launchctl")).toBe(true);
  });
});
