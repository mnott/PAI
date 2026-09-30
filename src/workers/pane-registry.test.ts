/**
 * Pane registry + close-ended tests. iTerm and tmux are never touched:
 * child_process is mocked, closing goes through injected PaneOps.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let nextSession = 0;
vi.mock("node:child_process", () => ({
  execFileSync: () => {
    throw new Error("mocked: no ps/plutil/tmux");
  },
  spawn: () => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: () => void; end: () => void } };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    const sess = `SESS-${++nextSession}`;
    proc.stdin = {
      write: () => undefined,
      end: () => {
        setTimeout(() => {
          proc.stdout.emit("data", Buffer.from(`|${sess}`));
          proc.emit("close", 0);
        }, 5);
      },
    };
    return proc;
  },
}));

import { closeEndedPanes, closePaneForWorker, loadRegistry, openPaneForWorker, type PaneOps } from "./pane.js";
import type { WorkersConfig } from "./config.js";

const config = { pane: { fontSize: 13, autoExitSecs: 10 } } as unknown as WorkersConfig;
const TERM = "w5t0p0:D38D3E5D-19E8-4FE5-A78A-26E8E571FE27";
let dir = "";
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-panereg-"));
  process.env.PAI_WORKER_PROFILE = join(dir, "profile.json");
  process.env.ITERM_SESSION_ID = TERM;
  delete process.env.TMUX;
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const fakeOps = (over: Partial<PaneOps> = {}): PaneOps & { closedIterm: string[]; closedTmux: string[] } => {
  const closedIterm: string[] = [];
  const closedTmux: string[] = [];
  return {
    closedIterm,
    closedTmux,
    listIterm: async () => [],
    closeIterm: async (id) => (closedIterm.push(id), true),
    listTmux: () => [],
    closeTmux: (id) => (closedTmux.push(id), true),
    ...over,
  };
};

describe("pane registry", () => {
  it("keeps all three entries when three workers open panes at once", async () => {
    const ids = ["20260929-203824-58109", "20260929-203825-59308", "20260929-203826-59992"];
    await Promise.all(ids.map((id) => openPaneForWorker(dir, config, id, TERM)));
    const reg = loadRegistry(dir);
    expect(reg.map((e) => e.worker).sort()).toEqual(ids);
    expect(new Set(reg.map((e) => e.session)).size).toBe(3);
  });

  it("still reads a legacy shared list", () => {
    mkdirSync(join(dir, "panes"), { recursive: true });
    writeFileSync(
      join(dir, "panes", "SCOPE.json"),
      JSON.stringify([{ session: "S1", worker: "20260929-100000-1", opened: "2026-09-29 10:00:00" }])
    );
    expect(loadRegistry(dir, "SCOPE").map((e) => e.session)).toEqual(["S1"]);
  });
});

describe("closing panes", () => {
  const seed = (worker: string, session: string, opened: string) => {
    mkdirSync(join(dir, "panes", "SCOPE"), { recursive: true });
    writeFileSync(join(dir, "panes", "SCOPE", `${worker}.json`), JSON.stringify({ session, worker, opened }));
  };

  it("closes by worker id and drops only that entry", async () => {
    seed("20260929-100000-1", "S1", "2026-09-29 10:00:00");
    seed("20260929-100001-2", "S2", "2026-09-29 10:00:01");
    const ops = fakeOps();
    expect(await closePaneForWorker(dir, "20260929-100001-2", ops)).toBe(true);
    expect(ops.closedIterm).toEqual(["S2"]);
    expect(readdirSync(join(dir, "panes", "SCOPE"))).toEqual(["20260929-100000-1.json"]);
  });

  it("--close-ended: closes ended, keeps running, iTerm and tmux, dry run touches nothing", async () => {
    seed("20260929-100000-1", "S1", "2026-09-29 10:00:00"); // ended, registered
    seed("20260929-100001-2", "S2", "2026-09-29 10:00:01"); // running, registered
    const over: Partial<PaneOps> = {
      listIterm: async () => [
        { id: "S1", name: "node pai worker follow 20260929-100000-1 --auto-exit 10" }, // also registered: once
        { id: "S9", name: "node pai worker follow 20260929-100009-9 --auto-exit 10" }, // ended, unregistered
        { id: "S8", name: "zsh" },
      ],
      listTmux: () => [
        { id: "%3", command: "node pai worker follow 20260929-100003-3 --auto-exit 10" }, // ended
        { id: "%4", command: "node pai worker follow 20260929-100001-2 --auto-exit 10" }, // running
      ],
    };
    const ended = (w: string) => w !== "20260929-100001-2";

    const dry = fakeOps(over);
    const d = await closeEndedPanes(dir, ended, true, dry);
    expect(d.closed.length).toBe(3);
    expect(dry.closedIterm).toEqual([]);
    expect(dry.closedTmux).toEqual([]);
    expect(existsSync(join(dir, "panes", "SCOPE", "20260929-100000-1.json"))).toBe(true);

    const live = fakeOps(over);
    const r = await closeEndedPanes(dir, ended, false, live);
    expect(live.closedIterm.sort()).toEqual(["S1", "S9"]);
    expect(live.closedTmux).toEqual(["%3"]);
    expect(r.kept.join("\n")).toContain("20260929-100001-2");
    expect(readdirSync(join(dir, "panes", "SCOPE"))).toEqual(["20260929-100001-2.json"]);
  });
});
