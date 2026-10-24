/**
 * provider-hold.test.ts — a provider hold queues new work (benchmark runs
 * excepted) while running work continues; the pool keeps no spares for a held
 * provider; the CLI round-trips the hold through workers.yaml.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capacityGate, queuedText, type CapacityOpts } from "./capacity.js";
import { defaultWorkersConfig, readWorkersSection } from "./config.js";
import { addProvider, describeProviders, holdProvider, releaseProvider } from "./providers.js";
import { starterWorkersYamlText, writeWorkersYamlText } from "./workers-config.js";
import type { WorkerStatus } from "./status.js";
import { isBenchmarkLabel } from "../daemon/battery-guard.js";
import { GROUPS } from "../cli/registry.js";
import { runCli, type Io } from "../cli/run.js";
import { makeStyle } from "../cli/help.js";

const dirs: string[] = [];
const savedYaml = process.env.PAI_WORKERS_YAML;
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedYaml;
});

function tempYaml(): { yamlPath: string; jsonPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pai-hold-"));
  dirs.push(dir);
  const yamlPath = join(dir, "workers.yaml");
  process.env.PAI_WORKERS_YAML = yamlPath;
  writeWorkersYamlText(yamlPath, starterWorkersYamlText());
  const jsonPath = join(dir, "config.json");
  addProvider({ name: "locp", baseUrl: "http://127.0.0.1:8123", model: "m", configPath: jsonPath });
  return { yamlPath, jsonPath };
}

describe("admission", () => {
  const st = (id: string): WorkerStatus => ({ id, pid: 100, provider: "locp", state: "running", turns: 0, origin: "spawn" }) as WorkerStatus;

  function gate(holdOf: (() => string | undefined) | undefined, cap: number | undefined = 4) {
    const logDir = mkdtempSync(join(tmpdir(), "pai-hold-gate-"));
    dirs.push(logDir);
    let t = 0;
    const lines: string[] = [];
    const opts: CapacityOpts = {
      logDir,
      self: { id: "me", provider: "locp", pid: 200 },
      cap,
      holdOf: holdOf ? () => holdOf() : undefined,
      config: defaultWorkersConfig().capacity,
      log: (l) => lines.push(l),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      load: () => [st("running-one")],
      isAlive: () => true,
    };
    return { opts, lines, elapsed: () => t };
  }

  it("a held provider queues the run with the reason until the hold is released", async () => {
    let held: string | undefined = "night run";
    const h = gate(() => held);
    const infos: Array<string | undefined> = [];
    h.opts.onWait = (i) => {
      if (i) infos.push(i.held);
      if (h.elapsed() >= 10_000) held = undefined;
    };
    const r = await capacityGate(h.opts);
    expect(r).not.toBeNull();
    expect(h.lines[0]).toContain("held: night run");
    expect(infos[0]).toBe("night run");
    expect(h.elapsed()).toBeGreaterThanOrEqual(10_000);
  });

  it("holds even a provider with no cap", async () => {
    let held: string | undefined = "x";
    const h = gate(() => held, undefined);
    h.opts.onWait = () => {
      if (h.elapsed() >= 5_000) held = undefined;
    };
    expect(await capacityGate(h.opts)).not.toBeNull();
    expect(h.lines[0]).toContain("held: x");
  });

  it("a run with no hold passed (benchmark-labelled) is admitted at once", async () => {
    expect(isBenchmarkLabel("eval k set rep1 bench")).toBe(true);
    expect(isBenchmarkLabel("refactor the parser")).toBe(false);
    const h = gate(undefined);
    expect(await capacityGate(h.opts)).toBeNull();
    expect(h.elapsed()).toBe(0);
  });

  it("the queue line names the hold", () => {
    expect(queuedText({ provider: "locp", position: 1, queued: 1, sinceMs: 0, held: "why" })).toContain("held: why");
  });
});

describe("workers.yaml hold", () => {
  it("holdProvider / releaseProvider write and clear hold on the provider; the list shows it", () => {
    const { yamlPath, jsonPath } = tempYaml();
    holdProvider("locp", "strata-bench r3 night run", jsonPath);
    const { workers } = readWorkersSection(jsonPath);
    expect(workers.providers.locp.hold?.reason).toBe("strata-bench r3 night run");
    expect(readFileSync(yamlPath, "utf8")).toContain("strata-bench r3 night run");
    expect(describeProviders(workers, jsonPath, new Map() as never).join("\n")).toMatch(/held since \d\d:\d\d: strata-bench r3 night run/);
    releaseProvider("locp", jsonPath);
    expect(readWorkersSection(jsonPath).workers.providers.locp.hold).toBeUndefined();
    expect(readFileSync(yamlPath, "utf8")).not.toContain("night run");
    expect(() => holdProvider("nope", "r", jsonPath)).toThrow(/no provider/);
    expect(() => holdProvider("locp", " ", jsonPath)).toThrow(/reason/);
  });

  it("CLI hold / release round-trip on a temp copy", async () => {
    const { yamlPath } = tempYaml();
    addProvider({ name: "locp", baseUrl: "http://127.0.0.1:8123", model: "m" });
    const out: string[] = [];
    const io: Io = { out: (s) => out.push(s), err: (s) => out.push(s), style: makeStyle(false) };
    expect(await runCli(GROUPS, ["worker", "providers", "hold", "locp", "--reason", "bench night"], io)).toBe(0);
    expect(readFileSync(yamlPath, "utf8")).toContain("bench night");
    expect(await runCli(GROUPS, ["worker", "providers", "release", "locp"], io)).toBe(0);
    expect(readFileSync(yamlPath, "utf8")).not.toContain("bench night");
  });
});
