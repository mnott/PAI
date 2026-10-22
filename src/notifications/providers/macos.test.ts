/**
 * MacOsProvider must never shell out to osascript off macOS — there is no
 * such binary on Linux/Windows, so the old code would spawn a process
 * guaranteed to fail (or, worse, run a same-named binary on PATH) every time
 * a notification fired on a non-darwin host.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { NotificationConfig } from "../types.js";

const REAL_PLATFORM = process.platform;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform });
}

const config: NotificationConfig = {
  mode: "auto",
  channels: {
    ntfy: { enabled: false },
    whatsapp: { enabled: false },
    macos: { enabled: true },
    voice: { enabled: false },
    cli: { enabled: false },
  },
  routing: { error: [], completion: [], info: [], progress: [], debug: [] },
};

describe("MacOsProvider.send off macOS", () => {
  afterEach(() => {
    setPlatform(REAL_PLATFORM);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns false without spawning osascript", async () => {
    setPlatform("linux");
    const spawnSpy = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnSpy }));

    const { MacOsProvider } = await import("./macos.js");
    const provider = new MacOsProvider();
    const result = await provider.send({ event: "info", message: "hi" }, config);

    expect(result).toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe("MacOsProvider.send script construction", () => {
  afterEach(() => {
    setPlatform(REAL_PLATFORM);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("passes message and title only as separate argv items; the script is constant", async () => {
    setPlatform("darwin");
    const spawnSpy = vi.fn(() => ({ unref() {}, on() {} }));
    vi.doMock("node:child_process", () => ({ spawn: spawnSpy }));
    const { MacOsProvider } = await import("./macos.js");
    const evil = 'x" & (do shell script "touch /tmp/pwn") & "';
    const evilTitle = 'T" & (do shell script "id") & "';
    await new MacOsProvider().send({ event: "info", message: evil, title: evilTitle }, config);

    const [bin, args] = spawnSpy.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe("osascript");
    const sep = args.indexOf("--");
    expect(args.slice(sep + 1)).toEqual([evil, evilTitle]);
    const script = args.slice(0, sep).join("\n");
    expect(script).not.toContain("shell script");
    expect(script).toContain("item 1 of argv");
  });
});
