/** setup must never overwrite user config values; skipped steps must write nothing. */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepMergeUserWins, setupOptions } from "./utils.js";
import { DICTATION_MODELS, dictationCurlCommand, dictationModelDirs, installedModelPath, readDictationModelId, writeDictationModelId } from "./dictation-models.js";
import { stepDictation } from "./steps/20-dictation.js";

const USER = {
  storageBackend: "sqlite",
  embeddingModel: "BAAI/bge-small-en-v1.5",
  workers: {
    enabled: true,
    pane: { autoExitSecs: 10 },
    routing: { priority: ["anthropic", "glm", "kimi"] },
    tree: { maxChildren: 16 },
    cacheKeepaliveSecs: 300,
    defaultMaxMinutes: 45,
    noBrowserByDefault: true,
    pool: { enabled: true, maxSlots: 8 },
  },
  router: { enabled: true, port: 9000, bind: "tailscale" },
  tasks: { enabled: true, providers: { todoist: { apiKey: "tok", rootProjectId: "p1" } } },
};

describe("deepMergeUserWins (user wins, missing keys added)", () => {
  it("does not overwrite existing values", () => {
    const merged = deepMergeUserWins(USER, {
      workers: { enabled: false, providers: {}, classes: {}, pane: { autoExitSecs: 5 }, routing: { priority: [] }, tree: { maxChildren: 4 } },
      router: { enabled: false },
      tasks: { enabled: false },
    });
    const w = merged.workers as Record<string, unknown>;
    expect(w.enabled).toBe(true);
    expect((w.pane as Record<string, unknown>).autoExitSecs).toBe(10);
    expect((w.routing as Record<string, unknown>).priority).toEqual(["anthropic", "glm", "kimi"]);
    expect((w.tree as Record<string, unknown>).maxChildren).toBe(16);
    expect(w.cacheKeepaliveSecs).toBe(300);
    expect(w.defaultMaxMinutes).toBe(45);
    expect(w.noBrowserByDefault).toBe(true);
    expect((w.pool as Record<string, unknown>).enabled).toBe(true);
    expect((w.pool as Record<string, unknown>).maxSlots).toBe(8);
    expect((merged.router as Record<string, unknown>).enabled).toBe(true);
    expect((merged.router as Record<string, unknown>).port).toBe(9000);
    expect((merged.router as Record<string, unknown>).bind).toBe("tailscale");
    expect((merged.tasks as Record<string, unknown>).enabled).toBe(true);
  });

  it("adds a missing nested key without touching siblings", () => {
    const merged = deepMergeUserWins(USER, { workers: { supervision: { enabled: true, intervalSecs: 60 } } });
    const w = merged.workers as Record<string, unknown>;
    expect(w.supervision).toEqual({ enabled: true, intervalSecs: 60 });
    expect(w.enabled).toBe(true);
    expect((w.pane as Record<string, unknown>).autoExitSecs).toBe(10);
  });

  it("adds a missing top-level section", () => {
    const merged = deepMergeUserWins(USER, { notifications: { enabled: true } });
    expect(merged.notifications).toEqual({ enabled: true });
  });

  it("adds missing keys inside an existing nested object", () => {
    const merged = deepMergeUserWins(USER, { workers: { pane: { fontSize: 14 } } });
    const pane = (merged.workers as Record<string, unknown>).pane as Record<string, unknown>;
    expect(pane.fontSize).toBe(14);
    expect(pane.autoExitSecs).toBe(10);
  });

  it("the user config is never mutated", () => {
    const snapshot = JSON.parse(JSON.stringify(USER));
    deepMergeUserWins(USER, { workers: { enabled: false, pane: { autoExitSecs: 5 } } });
    expect(USER).toEqual(snapshot);
  });
});

describe("skipped steps return nothing", () => {
  it("stepWorkers with --no-workers returns {}", async () => {
    const { setupOptions } = await import("./utils.js");
    setupOptions.yes = true;
    setupOptions.answers = { workers: false };
    const { stepWorkers } = await import("./steps/17-workers.js");
    expect(await stepWorkers({} as never)).toEqual({});
  });

  it("stepTaskBus with --no-task-bus returns {}", async () => {
    const { setupOptions } = await import("./utils.js");
    setupOptions.yes = true;
    setupOptions.answers = { "task-bus": false };
    const { stepTaskBus } = await import("./steps/16-task-bus.js");
    expect(await stepTaskBus({} as never)).toEqual({});
  });

  it("stepRouter with --no-router returns only enabled:false", async () => {
    const { setupOptions } = await import("./utils.js");
    setupOptions.yes = true;
    setupOptions.router = { enabled: false };
    const { stepRouter } = await import("./steps/19-router.js");
    expect(await stepRouter({} as never)).toEqual({ router: { enabled: false } });
  });
});

describe("dictation model step", () => {
  it("catalog and search order", () => {
    expect(DICTATION_MODELS.map((m) => [m.id, m.sizeMB])).toEqual([["large-v3-turbo-q5_0", 574], ["medium", 1530], ["small", 466], ["base", 142]]);
    expect(dictationModelDirs("/h")[1]).toBe(join("/h", ".cache", "aibroker-stt"));
    const hit = join("/h", ".cache", "aibroker-stt", "ggml-small.bin");
    expect(installedModelPath("small", "/h", (p) => p === hit)).toBe(hit);
    expect(installedModelPath("base", "/h", () => false)).toBeNull();
    expect(dictationCurlCommand("small")).toContain("resolve/main/ggml-small.bin");
  });
  it("write merges and keeps other keys", () => {
    const p = join(mkdtempSync(join(tmpdir(), "dict-")), "sub", "dictation.json");
    writeDictationModelId("base", p);
    writeFileSync(p, JSON.stringify({ language: "de", modelId: "x" }));
    writeDictationModelId("small", p);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ language: "de", modelId: "small" });
    expect(readDictationModelId(p)).toBe("small");
  });
  it("step skips on non-macOS and honours the flag", async () => {
    const home = mkdtempSync(join(tmpdir(), "dict-home-"));
    process.env.PAI_HOME = home;
    try {
      expect(await stepDictation({} as never, "linux")).toBeNull();
      setupOptions.yes = true;
      setupOptions.dictationModel = "base";
      expect(await stepDictation({} as never, "darwin")).toBe("base");
      expect(readDictationModelId(join(home, "dictation.json"))).toBe("base");
      setupOptions.dictationModel = undefined;
      expect(await stepDictation({} as never, "darwin")).toBe("base");
    } finally {
      delete process.env.PAI_HOME;
      setupOptions.yes = false;
      setupOptions.dictationModel = undefined;
    }
  });
});
