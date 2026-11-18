import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SystemMonitor } from "./system.js";
import { parseListenPorts } from "../workers/local-instances.js";

describe("no mactop in the router", () => {
  it("SystemMonitor never runs mactop or top", async () => {
    const cmds: string[] = [];
    const m = new SystemMonitor({ file: "/dev/null", telemetryFile: "/dev/null", run: async (c) => (cmds.push(c), "") });
    await m.current();
    expect(cmds.some((c) => /mactop|top$/.test(c))).toBe(false);
  });
  it("no router/workers source spawns mactop", () => {
    for (const dir of ["src/router", "src/workers", "src/daemon"]) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
        const src = readFileSync(join(dir, f), "utf8");
        expect(/\b(exec|execFile|spawn)\w*\([^)]*mactop/.test(src), `${dir}/${f}`).toBe(false);
      }
    }
  });
});

describe("listening-port parse", () => {
  it("collects ports from one lsof -Fpn listing", () => {
    expect([...parseListenPorts("p1\nn*:8037\nn127.0.0.1:11434\nn[::1]:80\n")].sort((a, b) => a - b)).toEqual([80, 8037, 11434]);
  });
});

describe("cockpit page script", () => {
  it("every inline script of the served page parses", async () => {
    const { Script } = await import("node:vm");
    const { cockpitHtml } = await import("./cockpit-page.js");
    const scripts = [...cockpitHtml().matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(() => new Script(src)).not.toThrow();
  });
  it("queue model column is a short name", async () => {
    const { shortModel } = await import("../workers/queue-table.js");
    expect(shortModel(true, "gyro-l", "gyro-l/qwen3.8-flash-next-gyro-l")).toBe("gyro-l");
    expect(shortModel(false, "anthropic", "claude-sonnet-5-5")).toBe("cloud: sonnet");
  });
});
