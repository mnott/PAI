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
