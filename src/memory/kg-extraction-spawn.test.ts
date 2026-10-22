import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plan = { args: [] as string[], env: process.env, model: "test", timeoutMs: 5000 };

vi.mock("../workers/daemon-llm.js", () => ({
  planLlmSpawn: async () => plan,
}));
vi.mock("../workers/pane-waiver.js", () => ({
  recordSystemJobStart: () => {},
}));

import { spawnClaude } from "./kg-extraction.js";

let dir: string;
const uncaught: unknown[] = [];
const onUncaught = (e: unknown): void => { uncaught.push(e); };

function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kg-spawn-"));
  uncaught.length = 0;
  process.on("uncaughtException", onUncaught);
  plan.timeoutMs = 5000;
});

afterEach(() => {
  process.off("uncaughtException", onUncaught);
  delete process.env.PAI_CLAUDE_BINARY;
  rmSync(dir, { recursive: true, force: true });
});

describe("spawnClaude child hardening", () => {
  it("returns null without an uncaught error when the child exits before reading a large prompt", async () => {
    process.env.PAI_CLAUDE_BINARY = "/usr/bin/true";
    const result = await spawnClaude("x".repeat(2 * 1024 * 1024));
    await new Promise((r) => setTimeout(r, 200));
    expect(uncaught).toEqual([]);
    expect(result).toBeNull();
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const marker = join(dir, "pid");
    process.env.PAI_CLAUDE_BINARY = script(
      "stubborn",
      `require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);`,
    );
    plan.timeoutMs = 300;
    const result = await spawnClaude("hi");
    expect(result).toBeNull();
    const { readFileSync } = await import("node:fs");
    const pid = Number(readFileSync(marker, "utf8"));
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true); // still alive right after SIGTERM
    await new Promise((r) => setTimeout(r, 3600));
    expect(alive()).toBe(false);
  }, 10000);

  it("kills the child and fails when stdout exceeds the cap", async () => {
    const marker = join(dir, "pid2");
    process.env.PAI_CLAUDE_BINARY = script(
      "flood",
      `require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));
const b = "a".repeat(1024 * 1024);
setInterval(() => { process.stdout.write(b); }, 5);`,
    );
    const result = await spawnClaude("hi");
    expect(result).toBeNull();
    const { readFileSync } = await import("node:fs");
    const pid = Number(readFileSync(marker, "utf8"));
    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10000);
});
