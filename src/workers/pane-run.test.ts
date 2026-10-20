import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { followPaneRun, loadPaneRunStatus, loadPaneRunStatuses, renderPaneRunLines, runInPane, type PaneRunOptions } from "./pane-run.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-panerun-"));
  vi.stubEnv("PAI_HOME", join(dir, "home"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function opts(command: string[], extra: Partial<PaneRunOptions> = {}): PaneRunOptions & { got: string[]; opened: string[] } {
  const got: string[] = [];
  const opened: string[] = [];
  return { command, logDir: dir, out: (s) => got.push(s), err: () => undefined, openPane: async (id) => (opened.push(id), "pane"), got, opened, ...extra };
}

describe("runInPane", () => {
  it("opens one pane, blocks, mirrors the exit code and prints the tail", async () => {
    const o = opts(["sh", "-c", "for i in $(seq 1 60); do echo line$i; done; exit 3"]);
    expect(await runInPane(o)).toBe(3);
    expect(o.opened).toHaveLength(1);
    const text = o.got.join("");
    expect(text).toContain("line60");
    expect(text).not.toContain("line10\n");
    expect(text).toContain("[exit 3");
    const st = loadPaneRunStatus(dir, o.opened[0])!;
    expect(st.state).toBe("failed");
    expect(st.exit).toBe(3);
    expect(readFileSync(st.log, "utf8")).toContain("line1\n");
    expect(st.log).toContain(join("logs", "panes"));
  });
  it("a single word runs through sh -c; success is 0", async () => {
    const o = opts(["echo hi && echo there"]);
    expect(await runInPane(o)).toBe(0);
    expect(o.got.join("")).toContain("there");
  });
  it("runs where asked and without a pane when none opens", async () => {
    const o = opts(["pwd"], { cwd: dir, openPane: async () => { throw new Error("no host"); } });
    expect(await runInPane(o)).toBe(0);
    expect(o.got.join("")).toContain(dir.replace(/^\/private/, ""));
  });
  it("lists the running command in ps until it ends", async () => {
    const o = opts(["sleep", "2"], { label: "nap" });
    const p = runInPane(o);
    await new Promise((r) => setTimeout(r, 300));
    expect(renderPaneRunLines(loadPaneRunStatuses(dir))[0]).toMatch(/^pane nap  .*  \d+s  .*\.log$/);
    await p;
    expect(renderPaneRunLines(loadPaneRunStatuses(dir))).toEqual([]);
  }, 10_000);
  it("a signal to the caller kills the command's process group", async () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const pidFile = join(dir, "pid");
    const o = opts(["sh", "-c", `sleep 60 & echo $! > ${pidFile}; wait`], { proc, killGraceMs: 500 });
    const p = runInPane(o);
    await new Promise((r) => setTimeout(r, 600));
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    proc.emit("SIGTERM");
    expect(await p).toBe(143);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(grandchild, 0)).toThrow();
    expect(o.got.join("")).toContain("(SIGTERM)");
  }, 15_000);
});

describe("followPaneRun", () => {
  it("shows the log and the exit line, then leaves after the linger", async () => {
    const o = opts(["sh", "-c", "echo hello; exit 2"]);
    await runInPane(o);
    let shown = "";
    await followPaneRun(dir, o.opened[0], (s) => (shown += s), 0, 10);
    expect(shown).toContain("hello");
    expect(shown).toContain("[exit 2");
  });

  it.each([[true], [false]])("writes the pane's purpose as the terminal title (OSC 1/2) at its start only to a TTY (tty=%s)", async (tty) => {
    const o = opts(["sleep", "1"], { label: "tests" });
    const p = runInPane(o);
    await new Promise((r) => setTimeout(r, 200));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const was = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
    try {
      await followPaneRun(dir, o.opened[0], () => undefined, 0, 10);
      const written = err.mock.calls.map((c) => String(c[0])).join("");
      if (!tty) {
        expect(written).toBe("");
        return;
      }
      // a pane-run pane shows its label alone, no provider
      expect(written).toContain("\x1b]1;tests\x07");
      expect(written).toContain("\x1b]2;tests\x07");
    } finally {
      if (was) Object.defineProperty(process.stdout, "isTTY", was);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      err.mockRestore();
      await p;
    }
  }, 10_000);
});
