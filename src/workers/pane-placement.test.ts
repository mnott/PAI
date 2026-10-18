/**
 * openVerifiedPane placement fallback: split too small -> new tab -> new window
 * -> the original error. Every iTerm step is a fake seam; nothing is opened.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openVerifiedPane, panePlacement, type PaneOps, type PaneSeam } from "./pane.js";
import type { WorkersConfig } from "./config.js";

const config = { pane: { fontSize: 13, autoExitSecs: 10 } } as unknown as WorkersConfig;
const UID = "D38D3E5D-19E8-4FE5-A78A-26E8E571FE27";
const TERM = `w5t0p0:${UID}`;
const env = { ITERM_SESSION_ID: TERM } as NodeJS.ProcessEnv;
const TOO_SMALL = "pane verification failed: pane too small, 26x14 < 40x8 (window 5322)";

let dir: string;
let rebalanced: number;
const ops: PaneOps = {
  listIterm: async () => [],
  closeIterm: async () => true,
  listTmux: () => [],
  closeTmux: () => true,
  rebalanceIterm: async () => {
    rebalanced++;
  },
};

function seam(opts: { split?: "ok" | "small"; tab?: "ok" | "fail"; window?: "ok" | "fail" }): PaneSeam & { placed: string[] } {
  const placed: string[] = [];
  return {
    placed,
    split: async () => ({ message: "pane opened", session: "S1" }),
    verify: async () => {
      if (opts.split === "small") throw new Error(TOO_SMALL);
      return "window 7 tab 1/1, pane 80x20";
    },
    place: async (_l, _c, _w, _t, _h, kind) => {
      placed.push(kind);
      if ((kind === "tab" ? opts.tab : opts.window) === "fail") throw new Error("pane verification failed: nope");
      return `window 7 new ${kind}`;
    },
  };
}

const open = (wid: string, s: PaneSeam) => openVerifiedPane(dir, config, wid, TERM, env, ops, s);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-placement-"));
  rebalanced = 0;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("openVerifiedPane placement", () => {
  it("roomy window: plain split, no fallback", async () => {
    const s = seam({ split: "ok" });
    await expect(open("w-split", s)).resolves.toContain("S1");
    expect(s.placed).toEqual([]);
    expect(panePlacement("w-split")).toBe("split");
  });

  it("too-small split -> new tab", async () => {
    const s = seam({ split: "small", tab: "ok" });
    await expect(open("w-tab", s)).resolves.toContain("new tab");
    expect(s.placed).toEqual(["tab"]);
    expect(panePlacement("w-tab")).toBe("tab");
    expect(rebalanced).toBe(0); // empty registry: nothing to re-balance
    expect(vi.mocked(process.stderr.write).mock.calls.join("")).toContain("pane: opened in a new tab (window too crowded)");
  });

  it("tab fails -> new window", async () => {
    const s = seam({ split: "small", tab: "fail", window: "ok" });
    await expect(open("w-win", s)).resolves.toContain("new window");
    expect(s.placed).toEqual(["tab", "window"]);
    expect(panePlacement("w-win")).toBe("window");
  });

  it("tab and window fail -> the original too-small error", async () => {
    const s = seam({ split: "small", tab: "fail", window: "fail" });
    await expect(open("w-none", s)).rejects.toThrow("pane too small, 26x14 < 40x8");
    expect(panePlacement("w-none")).toBeUndefined();
  });

  it("a non-size failure does not fall back", async () => {
    const s = seam({ split: "ok" });
    s.verify = async () => {
      throw new Error("pane verification failed: iTerm2 is hidden");
    };
    await expect(open("w-hidden", s)).rejects.toThrow("hidden");
    expect(s.placed).toEqual([]);
  });
});
