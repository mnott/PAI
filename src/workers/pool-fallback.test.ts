import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryPoolRun } from "./run.js";
import { ledgerPath } from "./paths.js";

// the follow pane is opened before the pool post; keep these tests off the real terminal
vi.mock("./pane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pane.js")>();
  return { ...actual, openVerifiedPane: vi.fn().mockResolvedValue("here"), openPaneForWorker: vi.fn(), resolveHostSession: vi.fn().mockResolvedValue({ term: "t" }) };
});

const args = (logDir: string, pool: boolean, over: Record<string, unknown> = {}) =>
  ({
    config: { pool: { enabled: pool, maxSlots: 1, idleSecs: 0, port: 1 } },
    logDir,
    quiet: true,
    id: "w-fb",
    label: "x",
    model: "m",
    cwd: tmpdir(),
    worktreeFlag: false,
    reportFormat: "ag2",
    noBrowser: true,
    target: { providerName: "glm", provider: { models: { default: "m" } } },
    parsed: { headless: true, prompt: "hi", callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: [], outputFormat: "json" },
    ...over,
  }) as never;

describe("pool fallback to a fresh spawn", () => {
  // a worker running the suite inherits PAI_WORKER=1, which lets hidden runs through and changes the pane path
  beforeEach(() => {
    for (const k of ["PAI_WORKER", "PAI_WORKER_PROVIDER", "PAI_SESSION_PROVIDER", "PAI_WORKER_AUTOPANE", "PAI_WORKER_ALLOW_HIDDEN"]) vi.stubEnv(k, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("pool off: null, nothing written", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-fb-"));
    expect(await tryPoolRun(args(d, false))).toBeNull();
    expect(existsSync(ledgerPath(d))).toBe(false);
  });

  it("ineligible run: null and the reason lands in the ledger", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-fb-"));
    expect(await tryPoolRun(args(d, true, { worktreeFlag: true }))).toBeNull();
    expect(readFileSync(ledgerPath(d), "utf8")).toMatch(/WORKER-POOL-SKIP id=w-fb provider=glm reason=worktree/);
  });

  it("eligible run but host unreachable: null (fresh spawn)", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-fb-"));
    expect(await tryPoolRun(args(d, true))).toBeNull();
  });
});
