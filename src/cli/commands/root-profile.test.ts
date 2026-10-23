import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeAnthropicModels, type WorkersConfig } from "../../workers/config.js";
import { getProfile, resolveWorkers, updateProfile } from "../../workers/session-profile.js";
import { makeStyle } from "../help.js";
import type { Setup } from "../lib/setups.js";
import { withSessionProfile } from "../impl/project/session-config.js";

const launched: Array<{ env: NodeJS.ProcessEnv; provider: string; model?: string }> = [];
vi.mock("../lib/harness.js", async (orig) => ({
  ...(await orig<typeof import("../lib/harness.js")>()),
  buildHarness: async (_w: unknown, o: { provider: string; model?: string; cwd: string }) => ({ cmd: "claude", argv: [], env: {}, cwd: o.cwd, provider: o.provider, model: o.model ?? "m" }),
  execHarness: (h: { env: NodeJS.ProcessEnv; provider: string; model?: string }) => (launched.push(h), 0),
}));

const { lastSetup, startSession } = await import("./root.js");
const { applyProfileChat } = await import("./session.js");

const mk = { enabled: true, protocol: "anthropic" as const, baseUrl: "https://x.invalid", keyFile: null, env: {}, models: { default: "m", fast: "f" } };
const workers = { active: "glm", nativeModels: { ...nativeAnthropicModels() }, providers: { glm: mk, kimi: mk }, logDir: "/tmp/none", routing: { budgetWalls: {} } } as unknown as WorkersConfig;
const term = () => ({ input: {} as never, output: { write: () => true } as never, isTTY: false, st: makeStyle(false) });

describe("session profile at launch", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "launch-prof-"));
    vi.stubEnv("PAI_HOME", home);
    launched.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("the profile supplies the chat model and the worker provider of the launch setup", () => {
    updateProfile("job-search", { chat: { provider: "anthropic", model: "opus" }, workers: { provider: "kimi", model: "fast" } });
    const s = lastSetup({ name: "job-search", provider: "glm", model: "m" } as never, workers);
    expect(s.orchestrator).toEqual({ provider: "anthropic", model: "opus" });
    expect(s.workers).toBe("kimi");
  });

  it("pai new/open: the profile chat replaces the default choice unless a flag named one", () => {
    updateProfile("job-search", { chat: { provider: "anthropic", model: "opus" } });
    const choice = { provider: "glm", model: "m" };
    applyProfileChat(choice, "job-search", workers);
    expect(choice).toEqual({ provider: "anthropic", model: "opus" });
    const other = { provider: "glm", model: "m" };
    applyProfileChat(other, "unprofiled", workers);
    expect(other).toEqual({ provider: "glm", model: "m" });
  });

  it("choosing a setup writes this session's profile (keeping its worker model) and nothing global", async () => {
    updateProfile("job-search", { workers: { provider: "kimi", model: "fast" }, fallback: [{ provider: "glm" }] });
    const setup: Setup = { name: "x", orchestrator: { provider: "anthropic", model: "opus" }, workers: "kimi", kind: "builtin" };
    const code = await startSession({ workers, setup, name: "job-search", cwd: home, dryRun: false, term: term() });
    expect(code).toBe(0);
    expect(getProfile("job-search")).toEqual({
      chat: { provider: "anthropic", model: "opus" },
      workers: { provider: "kimi", model: "fast" },
      workers_implicit: true,
      fallback: [{ provider: "glm" }],
    });
    expect(launched[0].env).toMatchObject({ PAI_SESSION_NAME: "job-search", PAI_SESSION_WORKER_PROVIDER: "kimi" });
    expect(readdirSync(home).sort()).toEqual(["session-profiles.yaml"]);
  });

  it("a launch-written workers pin never routes: after the launch a spawn keeps global routing", async () => {
    const setup: Setup = { name: "x", orchestrator: { provider: "anthropic", model: "opus" }, workers: "anthropic", kind: "builtin" };
    await startSession({ workers, setup, name: "PAI", cwd: home, dryRun: false, term: term() });
    const p = getProfile("PAI");
    expect(p?.workers).toEqual({ provider: "anthropic" });
    expect(p?.workers_implicit).toBe(true);
    // the launch env pin is gone with the launch; the implicit profile pin must not route
    const r = resolveWorkers({}, { cfg: workers, profile: p, env: {}, budgets: {}, routing: { cooldowns: {} } as never });
    expect(r.source).toBe("global");
    expect(r.description).toBe("global routing");
  });

  it("a launch overwrites the workers pin with the setup's (implicit); an explicit set restores routing", async () => {
    updateProfile("PAI", { workers: { provider: "kimi" } });
    const setup: Setup = { name: "x", orchestrator: { provider: "anthropic", model: "opus" }, workers: "glm", kind: "builtin" };
    await startSession({ workers, setup, name: "PAI", cwd: home, dryRun: false, term: term() });
    const p = getProfile("PAI");
    // the launch overwrote the pin with the setup's (glm, its "fast" worker model), marked implicit
    expect(p?.workers).toEqual({ provider: "glm", model: "fast" });
    expect(p?.workers_implicit).toBe(true);
    // the operator's explicit choice is restored and routes again
    updateProfile("PAI", { workers: { provider: "kimi" } });
    const r = resolveWorkers({}, { cfg: workers, profile: getProfile("PAI"), env: {}, budgets: {}, routing: { cooldowns: {} } as never });
    expect(r.source).toBe("profile");
    expect(r.provider).toBe("kimi");
  });

  it("a dry run writes nothing", async () => {
    const setup: Setup = { name: "x", orchestrator: { provider: "anthropic", model: "opus" }, workers: "glm", kind: "builtin" };
    await startSession({ workers, setup, name: "dry", cwd: home, dryRun: true, term: term() });
    expect(existsSync(join(home, "session-profiles.yaml"))).toBe(false);
  });

  it("AIBroker's closed-session start (pai project config --json) carries the profile in env and flags", () => {
    updateProfile("job-search", { chat: { provider: "anthropic", model: "opus" }, workers: { provider: "kimi" } });
    const e = withSessionProfile({ flags: "--dangerously-skip-permissions", env: { IS_SANDBOX: "1" } }, ["jobs", "job-search"]);
    expect(e.env).toEqual({ IS_SANDBOX: "1", PAI_SESSION_NAME: "job-search", PAI_SESSION_WORKER_PROVIDER: "kimi" });
    expect(e.flags).toBe("--dangerously-skip-permissions --model opus");
    expect(withSessionProfile({ flags: "x" }, ["nobody"])).toEqual({ flags: "x" });
  });

  it("a launch-written (implicit) workers pin is not exported to the session env", () => {
    updateProfile("job-search", { chat: { provider: "anthropic", model: "opus" }, workers: { provider: "anthropic" }, workers_implicit: true });
    const e = withSessionProfile({ flags: "x" }, ["job-search"]);
    expect(e.env).toEqual({ PAI_SESSION_NAME: "job-search" });
    expect(e.flags).toBe("x --model opus");
  });
});
