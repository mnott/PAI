import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embed = vi.hoisted(() => vi.fn());
vi.mock("../../memory/indexer-backend.js", () => ({ embedChunksWithBackend: embed }));

import { PASS_RETRY_DELAYS_MS, runEmbed } from "./scheduler.js";
import { passFailures, setStorageBackend, setRegistryBackend, setDaemonConfig } from "./state.js";
import type { StorageBackend } from "../../storage/interface.js";
import type { RegistryBackend } from "../../storage/registry-interface.js";
import type { PaiDaemonConfig } from "../config.js";

const MISSING =
  "Cannot find module '/repo/dist/indexer-backend-CJ0RGgMz.mjs' imported from /repo/dist/daemon-B.mjs";

describe("failed scheduled pass", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    passFailures.clear();
    embed.mockReset();
    setStorageBackend({ supportsPostgresFeatures: true } as unknown as StorageBackend);
    setRegistryBackend({ listProjects: async () => [] } as unknown as RegistryBackend);
    setDaemonConfig({} as PaiDaemonConfig);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is recorded in the status with the dist-changed hint", async () => {
    embed.mockRejectedValue(new Error(MISSING));
    await runEmbed();
    const f = passFailures.get("embed")!;
    expect(f.attempts).toBe(1);
    expect(f.gaveUp).toBe(false);
    expect(f.error).toContain("pai daemon restart");
  });

  it("retries with backoff, gives up after three retries, clears on success", async () => {
    embed.mockRejectedValue(new Error("boom"));
    await runEmbed();
    for (const delay of PASS_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    expect(embed).toHaveBeenCalledTimes(4);
    expect(passFailures.get("embed")).toMatchObject({ attempts: 4, gaveUp: true });
    expect(passFailures.get("embed")!.error).not.toContain("pai daemon restart");

    passFailures.set("embed", { at: 1, error: "x", attempts: 1, gaveUp: false });
    embed.mockResolvedValue(3);
    await runEmbed();
    expect(passFailures.has("embed")).toBe(false);
  });
});
