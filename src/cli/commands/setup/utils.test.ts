/** setup must never overwrite user config values; skipped steps must write nothing. */

import { describe, it, expect } from "vitest";
import { deepMergeUserWins } from "./utils.js";

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
