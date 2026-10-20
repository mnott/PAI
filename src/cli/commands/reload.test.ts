import { describe, expect, it } from "vitest";
import { reloadAll, type ReloadDeps } from "./reload.js";
import { GROUPS } from "../registry.js";

function deps(running: { daemon?: boolean; router?: boolean; pool?: boolean }, calls: string[]): ReloadDeps {
  return {
    codeInfo: () => "v1.2.3 built 2026-10-20 14:00:00",
    daemon: { pid: () => (running.daemon ? 10 : undefined), restart: () => (calls.push("daemon"), 11) },
    router: { pid: () => (running.router ? 20 : undefined), restart: async () => (calls.push("router"), 21) },
    pool: { reload: async () => (running.pool ? (calls.push("pool"), { oldPid: 30, newPid: 31, builtAt: "2026-10-20 14:00:00" }) : null) },
  };
}

describe("pai reload", () => {
  it("restarts daemon, router, pool host in that order, one line each with old/new pid and code version", async () => {
    const calls: string[] = [];
    const lines = await reloadAll(deps({ daemon: true, router: true, pool: true }, calls));
    expect(calls).toEqual(["daemon", "router", "pool"]);
    expect(lines).toEqual([
      "daemon: pid 10 -> 11, v1.2.3 built 2026-10-20 14:00:00",
      "router: pid 20 -> 21, v1.2.3 built 2026-10-20 14:00:00",
      "pool host: pid 30 -> 31, v1.2.3 built 2026-10-20 14:00:00 (bundle built 2026-10-20 14:00:00)",
    ]);
  });

  it("only restarts what is running", async () => {
    const calls: string[] = [];
    const lines = await reloadAll(deps({ router: true }, calls));
    expect(calls).toEqual(["router"]);
    expect(lines[0]).toBe("daemon: not running, skipped");
    expect(lines[2]).toBe("pool host: not running, skipped");
  });

  it("is registered as a top-level command", () => {
    expect(GROUPS.flatMap((g) => g.commands).some((c) => c.name === "reload")).toBe(true);
  });
});
