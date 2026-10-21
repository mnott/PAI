/** `worker run` through the launcher: pane first, claude as the wrapper's child, exit code and cancel. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pane from "./pane.js";
import { exitFilePath, runPaneExec } from "./pane-exec.js";
import { defaultWorkersConfig } from "./config.js";
import { releasePane, requireVisiblePane, spawnOwned } from "./run.js";

vi.mock("./pane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pane.js")>();
  return { ...actual, openVerifiedPane: vi.fn(), headlessAllowed: vi.fn() };
});

let dir: string;
let events: string[];
let wrappers: Promise<number>[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-owned-"));
  events = [];
  wrappers = [];
  vi.stubEnv("PAI_HOME", join(dir, "home"));
  vi.stubEnv("PAI_WORKER_AUTOPANE", undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.mocked(pane.headlessAllowed).mockReset().mockReturnValue(null);
  // the pane opener seam: opening a pane starts the wrapper the way iTerm would start it in the new pane
  vi.mocked(pane.openVerifiedPane)
    .mockReset()
    .mockImplementation(async (_l, _c, wid, _t, _e, _o, seam) => {
      events.push(`pane-open ${seam?.command}`);
      wrappers.push(runPaneExec(wid, { out: () => undefined, err: () => undefined, closePane: async () => void events.push("pane-close"), proc: new EventEmitter() as NodeJS.Process }));
      return "fake pane";
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const cfg = defaultWorkersConfig();
const sh = (script: string) => ["sh", "-c", script];

describe("a worker's command runs inside the pane that owns it", () => {
  it("pane first, then the command as the wrapper's child; exit code propagates; the pane closes", async () => {
    expect(await requireVisiblePane(dir, cfg, "w-own", "T", undefined, false, join(dir, "ledger.log"))).toBe(true);
    expect(events).toEqual([expect.stringContaining("pane exec w-own")]);
    events.push("spawn");
    const proc = await spawnOwned("w-own", sh("echo out; echo err >&2; exit 7"), { env: process.env, cwd: dir, stdio: ["pipe", "pipe", "pipe"], render: "plain", title: "t" });
    let out = "";
    proc.stdout!.on("data", (c: Buffer) => (out += c));
    const code = await new Promise<number>((r) => proc.on("close", (c: number | null) => r(c as number)));
    expect(code).toBe(7);
    expect(out).toBe("out\n");
    expect(await wrappers[0]).toBe(7);
    expect(events[1]).toBe("spawn");
    expect(events.at(-1)).toBe("pane-close");
    expect(JSON.parse(readFileSync(exitFilePath("w-own"), "utf8")).code).toBe(7);
  }, 15_000);

  it("a run that never reaches its command cancels its pane (the pane closes, nothing runs)", async () => {
    await requireVisiblePane(dir, cfg, "w-cancel", "T", undefined, false, join(dir, "ledger.log"));
    releasePane("w-cancel");
    expect(await wrappers[0]).toBe(0);
    expect(events).toContain("pane-close");
  }, 15_000);

  it("a pane that cannot open fails the run; only the config waiver or the override runs directly", async () => {
    vi.mocked(pane.openVerifiedPane).mockReset().mockRejectedValue(new Error("split failed"));
    await expect(requireVisiblePane(dir, cfg, "w-bad", "T", undefined, false, join(dir, "ledger.log"))).rejects.toThrow(/^no pane: split failed/);
    expect(readFileSync(join(dir, "ledger.log"), "utf8")).toMatch(/PANE-REFUSED/);
    expect(await requireVisiblePane(dir, { ...cfg, panes: { required: false } }, "w-np", "T", undefined, false, join(dir, "ledger.log"))).toBe(false);
    vi.mocked(pane.headlessAllowed).mockReturnValue("override");
    expect(await requireVisiblePane(dir, cfg, "w-ov", "T", undefined, false, join(dir, "ledger.log"))).toBe(false);
    // no pane owns it: the command is a plain child of the caller
    const proc = await spawnOwned("w-np", sh("exit 4"), { env: process.env, cwd: dir, stdio: ["pipe", "pipe", "pipe"], title: "t" });
    expect(await new Promise((r) => proc.on("close", r))).toBe(4);
  }, 15_000);

  it("no terminal at all: refused unless waived", async () => {
    vi.mocked(pane.openVerifiedPane).mockReset().mockRejectedValue(new pane.NoTerminalError("no terminal here"));
    await expect(requireVisiblePane(dir, cfg, "w-nt", "", undefined, false, join(dir, "ledger.log"))).rejects.toThrow(/^no pane: no terminal/);
  });
});
