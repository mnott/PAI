import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeAnthropicModels } from "../../workers/config.js";
import { getProfile } from "../../workers/session-profile-store.js";
import type { ResolveCtx } from "../../workers/session-profile.js";
import type { SessionProfileDeps } from "../../daemon-mcp/tools/session-profile.js";
import { sessionCommand } from "./session.js";

vi.mock("../../cli/impl/detect.js", () => ({ detectProject: vi.fn(async () => null) }));

const tmp = mkdtempSync(join(tmpdir(), "prof-cli-"));
vi.stubEnv("PAI_HOME", tmp);

const mk = { enabled: true, protocol: "anthropic" as const, baseUrl: "https://x.invalid", keyFile: null, env: {}, models: { default: "m", fast: "f" } };
const cfg = {
  active: "glm",
  nativeModels: { ...nativeAnthropicModels() },
  providers: { glm: mk, kimi: mk },
  routing: { budgetWalls: {} },
} as unknown as ResolveCtx["cfg"];

// the CLI runs the MCP tool implementation against a temp store and a fixed ctx
const deps: SessionProfileDeps = {
  path: join(tmp, "session-profiles.yaml"),
  env: { PAI_SESSION_NAME: "job-search" },
  ctx: async () => ({ cfg, profile: getProfile("job-search", deps.path), env: {}, budgets: {}, routing: { cooldowns: {} } }),
};
vi.mock("../../daemon-mcp/tools/session-profile.js", async (orig) => ({
  ...(await orig<typeof import("../../daemon-mcp/tools/session-profile.js")>()),
  realSessionProfileDeps: async () => deps,
}));

const profileCmd = sessionCommand.subcommands!.find((c) => c.name === "profile")!;
const run = async (argv: Record<string, string | undefined>, verb?: string) => {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    out += typeof c === "string" ? c : Buffer.from(c).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await profileCmd.run!({ args: verb ? { VERB: verb } : {}, opts: argv, dryRun: false, rest: [] });
  } finally {
    process.stdout.write = write;
  }
  return out;
};

describe("pai session profile", () => {
  beforeEach(() => {
    deps.path = join(mkdtempSync(join(tmpdir(), "prof-cli-")), "session-profiles.yaml");
  });

  it("show (the default verb) prints the profile and where the next spawn runs", async () => {
    const t = await run({});
    expect(t).toContain('session "job-search"');
    expect(t).toContain("workers: not set");
    expect(t).toContain("next worker spawn: global routing");
  });

  it("set --workers pins the provider and the next spawn reads it as a session profile", async () => {
    const t = await run({ workers: "kimi", model: "fast" }, "set");
    expect(t).toContain("workers: kimi fast");
    expect(t).toContain("next worker spawn: kimi fast (session profile)");
    expect(getProfile("job-search", deps.path)?.workers).toEqual({ provider: "kimi", model: "fast" });
    expect(getProfile("job-search", deps.path)?.workers_implicit).toBeUndefined();
  });

  it("clear --workers removes the pin and the spawn is global again", async () => {
    await run({ workers: "kimi" }, "set");
    const t = await run({ workers: "workers" }, "clear");
    expect(t).toContain("workers: not set");
    expect(t).toContain("next worker spawn: global routing");
    expect(getProfile("job-search", deps.path)?.workers).toBeUndefined();
  });

  it("--name acts on another session", async () => {
    const t = await run({ name: "other", workers: "glm" }, "set");
    expect(t).toContain('session "other"');
    expect(getProfile("other", deps.path)?.workers?.provider).toBe("glm");
  });

  it("bad usage fails with the next command", async () => {
    await expect(run({}, "set")).rejects.toThrow(/--workers <provider>/);
    await expect(run({}, "clear")).rejects.toThrow(/clear needs --workers/);
    await expect(run({}, "bogus")).rejects.toThrow(/expected show, set, clear or repair/);
  });

  it("repair clears this cwd's named session's launch-written pin and lists the rest", async () => {
    const launchPin = { chat: { provider: "anthropic", model: "opus" }, workers: { provider: "anthropic" } };
    // the repair reads the cwd's project name through detectProject; no registry here
    const { detectProject } = await import("../../cli/impl/detect.js");
    const prev = vi.mocked(detectProject).mockImplementation(async () => ({ slug: "pai", display_name: "PAI" }) as never);
    const { updateProfile } = await import("../../workers/session-profile-store.js");
    updateProfile("PAI", launchPin, deps.path);
    updateProfile("AIBroker", launchPin, deps.path);
    const cwd = process.cwd();
    try {
      process.cwd = () => "/repo/pai";
      // the repair runs on the same store as the profile API (deps.path)
      const t = await run({}, "repair");
      expect(t).toContain("cleared the launch-written workers pin: PAI");
      expect(t).toContain("left alone (not this session's): AIBroker (workers anthropic)");
      expect(getProfile("PAI", deps.path)?.workers).toBeUndefined();
      expect(getProfile("AIBroker", deps.path)?.workers).toEqual({ provider: "anthropic" });
    } finally {
      process.cwd = () => cwd;
      vi.mocked(detectProject).mockRestore();
    }
  });
});

afterEach(() => vi.unstubAllEnvs());
