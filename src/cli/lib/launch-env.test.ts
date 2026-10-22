/**
 * Native launches must never hand ANTHROPIC_API_KEY to claude: a key left in
 * the shell would bill the API instead of the subscription. spawnSync is
 * stubbed — claude is never started.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";

const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];

vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    spawnSync: (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ cmd, args, env: opts?.env });
      return { status: 0, stdout: "", stderr: "", error: undefined };
    },
  };
});

import { launchInDir } from "./launch.js";
import { nativeLaunchEnv } from "../../workers/run-env.js";

describe("native launch env", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, marker: process.env.PAI_ENV_MARKER };
  beforeEach(() => {
    calls.length = 0;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.PAI_ENV_MARKER = "kept";
  });
  afterEach(() => {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.marker === undefined) delete process.env.PAI_ENV_MARKER;
    else process.env.PAI_ENV_MARKER = saved.marker;
    process.exitCode = 0;
  });

  it("helper drops the key and keeps other vars", () => {
    const env = nativeLaunchEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PAI_ENV_MARKER).toBe("kept");
  });

  it("fresh launch spawns claude without ANTHROPIC_API_KEY", () => {
    launchInDir(tmpdir(), "Sample", { forceFresh: true });
    const c = calls.find((x) => x.cmd === "claude");
    expect(c).toBeDefined();
    expect(c!.env!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c!.env!.PAI_ENV_MARKER).toBe("kept");
  });

  it("resume launch never passes ANTHROPIC_API_KEY to any spawn", () => {
    launchInDir(tmpdir(), "Sample", { resumableUuid: "00000000-0000-4000-8000-000000000000" });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) if (c.env) expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
