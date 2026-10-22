/** `worker run` through the launcher: pane first, claude as the wrapper's child, exit code and cancel. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pane from "./pane.js";
import { exitFilePath, queuedPath, runPaneExec } from "./pane-exec.js";
import { defaultWorkersConfig } from "./config.js";
import { paneHandles } from "./run/pane-handles.js";
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
      wrappers.push(runPaneExec(wid, { out: () => undefined, err: () => undefined, closePane: async () => void events.push("pane-close"), proc: new EventEmitter() as NodeJS.Process, linger: 0 }));
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

describe("a pane that waits for a provider slot shows it is queued", () => {
  const queuedJson = { provider: "gyro-m", position: 2, queued: 5, elapsedSec: 130, label: "fix nav" };

  /** The wrapper of a pane that opened but has not received its start frame yet. */
  const waitingWrapper = (id: string, lines: string[], queuedDir: string) =>
    runPaneExec(id, {
      out: () => undefined,
      err: (s) => lines.push(s.toString()),
      closePane: async () => undefined,
      proc: new EventEmitter() as NodeJS.Process,
      linger: 0,
      tty: false,
      connectMs: 300,
      queuedDir,
      queuedPollMs: 50,
    });

  it("the wrapper prints the queue line in place and clears it when the command starts", async () => {
    const qdir = join(dir, "queued");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "w-q.queued"), JSON.stringify(queuedJson));
    const lines: string[] = [];
    const wrapper = waitingWrapper("w-q", lines, qdir);
    await vi.waitFor(() => expect(lines.some((l) => l.includes("queued on gyro-m · position 2 of 5 · waiting 2m10s · fix nav"))).toBe(true));
    expect(await wrapper).toBe(1); // no caller listens: the wrapper ends, the pane closes
    expect(lines.some((l) => l.startsWith("\r\x1b[K") && !l.includes("queued on"))).toBe(true); // the queue line is cleared as the wrapper ends
  }, 15_000);

  it("a malformed queue file shows nothing and never crashes the wrapper", async () => {
    const qdir = join(dir, "queued-bad");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "w-qbad.queued"), "not json");
    const lines: string[] = [];
    const wrapper = waitingWrapper("w-qbad", lines, qdir);
    expect(await wrapper).toBe(1); // the wrapper ends on its own: the bad file drew nothing and crashed nothing
    expect(lines).toEqual(["pai pane exec: no caller listens for w-qbad; nothing to run\n"]);
  }, 15_000);

  it("the caller's setQueued writes the file beside the launch record; start and cancel clear it", async () => {
    await requireVisiblePane(dir, cfg, "w-caller", "T", undefined, false, join(dir, "ledger.log"));
    paneHandles.get("w-caller")!.setQueued(queuedJson);
    expect(JSON.parse(readFileSync(queuedPath("w-caller"), "utf8"))).toEqual(queuedJson);
    const proc = await spawnOwned("w-caller", sh("true"), { env: process.env, cwd: dir, stdio: ["pipe", "pipe", "pipe"], title: "t" });
    expect(await new Promise((r) => proc.on("close", r))).toBe(0);
    expect(existsSync(queuedPath("w-caller"))).toBe(false); // the command started: the queue file is gone
    await requireVisiblePane(dir, cfg, "w-cancel2", "T", undefined, false, join(dir, "ledger.log"));
    paneHandles.get("w-cancel2")!.setQueued(queuedJson);
    releasePane("w-cancel2");
    expect(existsSync(queuedPath("w-cancel2"))).toBe(false); // a run that never starts leaves no queue file
  }, 15_000);
});
