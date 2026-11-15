import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkersConfig } from "../config.js";
import { workersLabel } from "./status-route.js";
import { renderStatusLine } from "../render.js";
import type { WorkerStatus } from "../status.js";

const cfg = {} as WorkersConfig;
const dir = () => mkdtempSync(join(tmpdir(), "route-label-"));

describe("workersLabel", () => {
  it("global routing shows the default tier label, cached for 30 s", async () => {
    const d = dir();
    let calls = 0;
    const compute = async () => (++calls, "local gyro-m");
    expect(await workersLabel({}, cfg, d, compute, 1000)).toBe("local gyro-m");
    expect(await workersLabel({}, cfg, d, compute, 5000)).toBe("local gyro-m");
    expect(calls).toBe(1);
    await workersLabel({}, cfg, d, compute, 40_000);
    expect(calls).toBe(2);
  });
  it("explicit pin keeps its label and skips the lookup", async () => {
    const compute = async () => {
      throw new Error("must not run");
    };
    expect(await workersLabel({ provider: "glm", model: "fast" }, cfg, dir(), compute)).toBe("glm/fast");
    expect(await workersLabel({ provider: "glm", model: "default" }, cfg, dir(), compute)).toBe("glm");
  });
  it("lookup errors give no label", async () => {
    const compute = async () => {
      throw new Error("x");
    };
    expect(await workersLabel({}, cfg, dir(), compute)).toBeUndefined();
  });
});

describe("renderStatusLine orchestrator split", () => {
  const now = new Date("2026-11-15T12:00:40");
  const st = (id: string, className: string, provider: string, model: string) =>
    ({ id, state: "running", started: "2026-11-15T12:00:00", className, provider, model, pid: process.pid }) as unknown as WorkerStatus;
  it("orchestrator is shown apart, only workers count in the arrow", () => {
    const out = renderStatusLine([st("o", "orchestrate", "anthropic", "claude-sonnet-5-5"), st("a", "implement", "gyro-m", ""), st("b", "implement", "gyro-m", "")], now);
    expect(out).toMatch(/^orch sonnet-5\.5 · ▶2 · gyro-m ×2 · oldest/);
  });
  it("orchestrator alone has no arrow", () => {
    expect(renderStatusLine([st("o", "plan", "anthropic", "claude-sonnet-5-5")], now)).toBe("orch sonnet-5.5");
  });
});
