/**
 * openVerifiedPane placement fallback: split in the host tab only: a crowded tab is
 * re-split once, never a tab or a window. Every iTerm step is a fake seam; nothing is opened.
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
const TOO_SMALL = "pane verification failed: pane too small, 26x14 < 40x6 (window 5322)";

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

function seam(opts: { split?: "ok" | "small" | "small-once"; hostSelected?: boolean }): PaneSeam & { splits: number } {
  const o = { splits: 0 };
  return Object.assign(o, {
    hostSelected: async () => opts.hostSelected !== false,
    split: async () => {
      o.splits++;
      return { message: "pane opened", session: `S${o.splits}` };
    },
    verify: async () => {
      if (opts.split === "small" || (opts.split === "small-once" && o.splits === 1)) throw new Error(TOO_SMALL);
      return "window 7 tab 1/1, pane 80x20";
    },
  });
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
  it("roomy tab: plain split", async () => {
    const s = seam({ split: "ok" });
    await expect(open("w-split", s)).resolves.toContain("S1");
    expect(s.splits).toBe(1);
    expect(panePlacement("w-split")).toBe("split");
  });

  it("crowded tab: rebalance and split again, still a split", async () => {
    const s = seam({ split: "small-once" });
    await expect(open("w-crowd", s)).resolves.toContain("S2");
    expect(s.splits).toBe(2);
    expect(rebalanced).toBe(1);
    expect(panePlacement("w-crowd")).toBe("split");
  });

  it("truly no room: rejected with the size error, never a tab or window", async () => {
    const s = seam({ split: "small" });
    await expect(open("w-none", s)).rejects.toThrow("pane too small, 26x14 < 40x6");
    expect(panePlacement("w-none")).toBeUndefined();
  });

  it("host tab not selected: still a split of the host tab", async () => {
    const s = seam({ hostSelected: false });
    await expect(open("w-bg", s)).resolves.toContain("S1");
    expect(s.splits).toBe(1);
    expect(panePlacement("w-bg")).toBe("split");
  });

  it("a non-size failure does not fall back", async () => {
    const s = seam({ split: "ok" });
    s.verify = async () => {
      throw new Error("pane verification failed: iTerm2 is hidden");
    };
    await expect(open("w-hidden", s)).rejects.toThrow("hidden");
    expect(s.splits).toBe(1);
  });
});

describe("openVerifiedPane without any host", () => {
  const bare = (daemon: boolean) => openVerifiedPane(dir, config, "w-none", "", {}, ops, { ...seam({ split: "ok" }), daemon: () => daemon });
  it("refuses with the daemon reason under the Claude background daemon", async () => {
    await expect(bare(true)).rejects.toThrow(/neither TMUX nor ITERM_SESSION_ID is set.*runs under the Claude background daemon; no attached terminal found/);
  });
  it("keeps the plain refusal elsewhere", async () => {
    await expect(bare(false)).rejects.not.toThrow(/background daemon/);
  });
  it("a resolved host without ITERM_SESSION_ID is accepted", async () => {
    await expect(openVerifiedPane(dir, config, "w-res", TERM, {}, ops, seam({ split: "ok" }))).resolves.toContain("S1");
  });
});
