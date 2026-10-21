import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultWorkersConfig } from "../../workers/config.js";
import { runInPane } from "../../workers/pane-run.js";

const launchPane = vi.fn();
vi.mock("../../workers/pane-launch.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../workers/pane-launch.js")>()), launchPane: (...a: unknown[]) => launchPane(...a) }));
vi.mock("../../workers/pane.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../workers/pane.js")>()),
  resolveHostSession: vi.fn().mockResolvedValue({ term: "t" }),
  inVisiblePane: vi.fn().mockReturnValue(false),
  headlessAllowed: vi.fn().mockReturnValue(null),
}));

const { paneLauncher } = await import("./pane.js");

describe("pai pane run without a pane", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-pane-required-"));
    launchPane.mockReset();
    vi.stubEnv("PAI_PANE_RUN_LOG_DIR", dir);
  });

  it("no pane could be opened: the command is not run, 'no pane: <reason>', PANE-REFUSED", async () => {
    launchPane.mockResolvedValue(null);
    const marker = join(dir, "ran");
    const errs: string[] = [];
    const rc = await runInPane({ command: [`touch ${marker}`], logDir: dir, launch: paneLauncher(dir, defaultWorkersConfig()), out: () => undefined, err: (s) => void errs.push(s) });
    expect(rc).toBe(1);
    expect(() => readFileSync(marker)).toThrow();
    expect(errs.join("\n")).toMatch(/no pane: no terminal/);
    expect(readFileSync(join(dir, "ledger.log"), "utf8")).toContain("PANE-REFUSED");
  });

  it("an opener that throws fails the run the same way", async () => {
    launchPane.mockRejectedValue(new Error("split failed"));
    await expect(paneLauncher(dir, defaultWorkersConfig())("p1")).rejects.toThrow("split failed");
  });

  it("workers.panes.required=false: runs headless, ledgered PANE-WAIVED, no pane opened", async () => {
    const launch = paneLauncher(dir, { ...defaultWorkersConfig(), panes: { required: false } });
    expect(await launch("p2")).toBeNull();
    expect(launchPane).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "ledger.log"), "utf8")).toContain("PANE-WAIVED");
  });
});
