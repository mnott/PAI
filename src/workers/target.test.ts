import { describe, expect, it } from "vitest";
import { resolveTarget, type TargetDeps } from "./target.js";
import { NoLocalServerError } from "./local-provider.js";
import { applyTarget } from "../cli/commands/worker.js";
import type { RunContext } from "../cli/define.js";

const prov = (baseUrl: string) => ({ enabled: true, protocol: "anthropic", baseUrl, keyFile: null, models: { default: "m" }, env: {} });
const deps = (up: boolean): TargetDeps =>
  ({
    workers: { providers: { "gyro-l": prov("http://127.0.0.1:9101") }, nativeModels: {}, active: null },
    logDir: "/nonexistent-pai-test-logdir",
    env: {},
    check: async () => up,
    localFailures: () => 0,
  }) as unknown as TargetDeps;

describe("--where local", () => {
  it("never reroutes to the cloud, even for a task the classifier calls cloud", async () => {
    const t = await resolveTarget({ where: "local", label: "Install devices (#1)", task: "migrate the device installer" }, deps(true));
    expect(t.provider).toBe("gyro-l");
    expect(t.description).toMatch(/^local: gyro-l/);
  });
  it("refuses when no local runtime is running", async () => {
    await expect(resolveTarget({ where: "local", label: "x" }, deps(false))).rejects.toBeInstanceOf(NoLocalServerError);
  });
  it("applyTarget pins the run through --local: localFlag, no providerFlag, no escalation", async () => {
    const plan: any = { kind: "run", run: { claudeArgs: [], label: "l" } };
    const ctx = { args: {}, opts: { where: "local" }, dryRun: false, rest: [] } as RunContext;
    await applyTarget(ctx, plan, async () => ({ provider: "gyro-l", description: "local: gyro-l" }));
    expect(plan.run.localFlag).toBe(true);
    expect(plan.run.providerFlag).toBeUndefined();
    expect(plan.run.noEscalate).toBe(true);
  });
});
