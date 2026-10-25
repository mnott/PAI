import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRunnerArgs } from "./args.js";
import { readWorkersSection } from "./config.js";
import { resolveTarget } from "./routing.js";
import { gateStart } from "./run.js";
import { loadStatuses, saveStatus } from "./status.js";
import { updateProfile } from "./session-profile-store.js";

// gateStart opens the follow pane at spawn; keep these tests off the real terminal
vi.mock("./pane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pane.js")>();
  return { ...actual, openVerifiedPane: vi.fn().mockResolvedValue("here"), openPaneForWorker: vi.fn(), resolveHostSession: vi.fn().mockResolvedValue({ term: "t" }) };
});

const saved = { yaml: process.env.PAI_WORKERS_YAML, home: process.env.PAI_HOME, name: process.env.PAI_SESSION_NAME };
afterEach(() => {
  for (const [k, v] of [["PAI_WORKERS_YAML", saved.yaml], ["PAI_HOME", saved.home], ["PAI_SESSION_NAME", saved.name]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// an uncapped cloud provider: only the session's max_parallel can hold a run
const YAML = `active: cloudy
providers:
  cloudy:
    url: https://api.example.com
    tier: 1
    models:
      default: m
      fast: m
`;

describe("session max_parallel on the real gate path", () => {
  it("the second worker of the session waits until the first ends; another session's does not", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-sessmax-"));
    writeFileSync(join(d, "workers.yaml"), YAML);
    process.env.PAI_WORKERS_YAML = join(d, "workers.yaml");
    process.env.PAI_HOME = d;
    process.env.PAI_SESSION_NAME = "s1";
    updateProfile("s1", { max_parallel: 1 });
    const { workers: config } = readWorkersSection();
    const logDir = join(d, "logs");
    const target = resolveTarget(config, { provider: "cloudy" } as never) as never;
    const args = (id: string) =>
      ({ config, logDir, quiet: true, id, label: id, model: "m", cwd: d, worktreeFlag: false, noStagger: true, target, parsed: parseRunnerArgs(["-p", "x", "--output-format", "json"]) }) as never;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);

    await gateStart(args("first"));
    let second = false;
    const gate = gateStart(args("second")).then(() => (second = true));
    await new Promise((r) => setTimeout(r, 1200));
    expect(second).toBe(false);
    expect(loadStatuses(logDir).find((s) => s.id === "second")?.state).toBe("queued");

    // another session is not held
    process.env.PAI_SESSION_NAME = "s2";
    await gateStart(args("other"));
    expect(loadStatuses(logDir).find((s) => s.id === "other")?.state).toBe("running");
    spy.mockRestore();

    saveStatus(logDir, { ...loadStatuses(logDir).find((s) => s.id === "first")!, state: "done", rc: 0 });
    await gate;
    expect(second).toBe(true);
    expect(loadStatuses(logDir).find((s) => s.id === "second")?.state).toBe("running");
  }, 30_000);
});
