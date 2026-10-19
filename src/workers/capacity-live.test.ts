import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRunnerArgs } from "./args.js";
import { readWorkersSection } from "./config.js";
import { resolveTarget } from "./routing.js";
import { gateStart } from "./run.js";
import { loadStatuses, nowStamp, saveStatus, type WorkerStatus } from "./status.js";

const savedYaml = process.env.PAI_WORKERS_YAML;
afterEach(() => {
  if (savedYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedYaml;
});

const YAML = `active: local30x8
providers:
  local30x8:
    url: http://127.0.0.1:8034
    tier: 1
    maxConcurrent: 1
    models:
      default: qwen3-coder-30b-8bit
      fast: qwen3-coder-30b-8bit
`;

const running = (id: string, provider: string): WorkerStatus => ({
  id,
  pid: process.pid,
  label: "x",
  cwd: "/",
  term: "",
  provider,
  model: "m",
  state: "running",
  started: nowStamp(),
  updated: nowStamp(),
  turns: 0,
  tools: 0,
  last: "p",
  rc: null,
  secs: null,
});

describe("capacity gate on the real config + argument path", () => {
  it("workers.yaml maxConcurrent reaches the provider, so a run behind a holder queues", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-caplive-"));
    const yamlPath = join(d, "workers.yaml");
    writeFileSync(yamlPath, YAML);
    process.env.PAI_WORKERS_YAML = yamlPath;
    const { workers: config } = readWorkersSection(join(d, "config.json"));
    expect(config.providers.local30x8.maxConcurrent).toBe(1);

    const logDir = join(d, "logs");
    saveStatus(logDir, running("holder-a", "local30x8"));
    saveStatus(logDir, running("holder-b", "local30x8"));

    const target = resolveTarget(config, logDir, { flagProvider: "local30x8", className: "simple" });
    const parsed = parseRunnerArgs(["-p", "Reply ok", "--output-format", "json"]);
    const a = {
      config,
      logDir,
      quiet: true,
      id: "probe",
      label: "gate probe",
      model: "m",
      cwd: d,
      worktreeFlag: false,
      noStagger: true,
      target,
      parsed,
    } as never;

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => (writes.push(String(s)), true)) as never);
    let passed = false;
    const gate = gateStart(a).then(() => (passed = true));
    await new Promise((r) => setTimeout(r, 1200));
    expect(passed).toBe(false);
    spy.mockRestore();
    expect(writes.join("")).toContain("queued:");
    expect(loadStatuses(logDir).find((s) => s.id === "probe")?.runPid).toBe(process.pid);
    expect(loadStatuses(logDir).find((s) => s.id === "probe")?.capacity?.cap).toBe(1);

    saveStatus(logDir, { ...running("holder-a", "local30x8"), state: "done", rc: 0 });
    saveStatus(logDir, { ...running("holder-b", "local30x8"), state: "done", rc: 0 });
    await gate;
    expect(passed).toBe(true);
  }, 30_000);
});
