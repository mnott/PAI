/**
 * Setup embedding step: backend detection runs under --yes without reading
 * stdin; a fresh install adopts the recommended backend, an existing one only
 * reports it. HOME points at a temp dir so no real config is read or written.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rl = {
  question: () => {
    throw new Error("stdin was read under --yes");
  },
} as never;

let home: string;

async function load(recommended: string | null) {
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAI_DIR", join(home, ".claude"));
  vi.doMock("../../../memory/backends/index.js", async (orig) => ({
    ...(await orig<typeof import("../../../memory/backends/index.js")>()),
    detectBackends: async () => ({
      results: [{ id: "ollama-f16", ok: recommended === "ollama-f16", reason: "stub" }],
      recommended,
    }),
  }));
  const utils = await import("./utils.js");
  const step = await import("./steps/03-embedding.js");
  utils.setupOptions.yes = true;
  return { utils, step };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-setup-embed-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("stepEmbedding backend detection", () => {
  it("fresh install under --yes adopts ollama when it is the recommended backend", async () => {
    const { step } = await load("ollama-f16");
    const cfg = await step.stepEmbedding(rl);
    expect(cfg.embeddingModel).toBe("Snowflake/snowflake-arctic-embed-m-v1.5");
    expect(cfg.embedding).toMatchObject({ backend: "ollama-f16" });
  });

  it("fresh install keeps the default backend when ollama is not available", async () => {
    const { step } = await load("transformers-cpu-q8");
    const cfg = await step.stepEmbedding(rl);
    expect(cfg.embedding).toBeUndefined();
  });

  it("an existing install is never switched", async () => {
    const { utils, step } = await load("ollama-f16");
    utils.mergeConfig({ embeddingModel: "Snowflake/snowflake-arctic-embed-m-v1.5" });
    const cfg = await step.stepEmbedding(rl);
    expect(cfg.embedding).toBeUndefined();
  });
});
