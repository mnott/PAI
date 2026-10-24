/**
 * openVerifiedPane placement fallback: split in the host tab only: a crowded tab is
 * re-split once, never a tab or a window. Every iTerm step is a fake seam; nothing is opened.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { ledgerPath } from "./paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openVerifiedPane, panePlacement, type PaneOps, type PaneSeam } from "./pane.js";
import type { WorkersConfig } from "./config.js";

const config = { pane: { fontSize: 13, autoExitSecs: 10 } } as unknown as WorkersConfig;
const UID = "D38D3E5D-19E8-4FE5-A78A-26E8E571FE27";
const TERM = `w5t0p0:${UID}`;
const env = { ITERM_SESSION_ID: TERM } as NodeJS.ProcessEnv;
const CROWDED = "window 5322 tab 1/1, pane 26x14";

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

function seam(opts: { split?: "ok" | "small"; hostSelected?: boolean }): PaneSeam & { splits: number } {
  const o = { splits: 0 };
  return Object.assign(o, {
    hostSelected: async () => opts.hostSelected !== false,
    split: async () => {
      o.splits++;
      return { message: "pane opened", session: `S${o.splits}` };
    },
    verify: async () => {
      if (opts.split === "small") return CROWDED;
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

  it("crowded tab: the worker starts in a small pane, unmarked and un-ledgered", async () => {
    const s = seam({ split: "small" });
    await expect(open("w-crowd", s)).resolves.toContain("26x14");
    expect(s.splits).toBe(1);
    expect(panePlacement("w-crowd")).toBe("split");
    expect(existsSync(ledgerPath(dir))).toBe(false);
  });

  it("host tab not selected: still a split of the host tab", async () => {
    const s = seam({ hostSelected: false });
    await expect(open("w-bg", s)).resolves.toContain("S1");
    expect(s.splits).toBe(1);
    expect(panePlacement("w-bg")).toBe("split");
  });

  it("a real verification failure still refuses and does not fall back", async () => {
    const s = seam({ split: "ok" });
    s.verify = async () => {
      throw new Error("pane verification failed: `worker follow w-gone` is not running in the pane");
    };
    await expect(open("w-gone", s)).rejects.toThrow("not running");
    expect(s.splits).toBe(1);
  });

  it.each(["NOT SELECTED", "MINIMISED", "HIDDEN", "OFF SCREEN"])("%s: the start proceeds with the mark, logged", async (mark) => {
    const s = seam({ split: "ok" });
    s.verify = async () => `window 7 tab 2/2, pane 76x5 ${mark}`;
    const wid = `w-${mark.replace(" ", "")}`;
    await expect(open(wid, s)).resolves.toContain(mark);
    expect(panePlacement(wid)).toBe("split");
    expect(readFileSync(ledgerPath(dir), "utf8")).toMatch(new RegExp(`PANE-MARK.*${wid}.*${mark}`));
  });
});

describe("openVerifiedPane without any host", () => {
  const bare = (daemon: boolean) => openVerifiedPane(dir, config, "w-none", "", {}, ops, { ...seam({ split: "ok" }), daemon: () => daemon });
  it("reports the daemon reason under the Claude background daemon (the caller starts the worker without a pane)", async () => {
    await expect(bare(true)).rejects.toThrow(/neither TMUX nor ITERM_SESSION_ID is set.*runs under the Claude background daemon; no attached terminal found/);
  });
  it("keeps the plain refusal elsewhere", async () => {
    await expect(bare(false)).rejects.not.toThrow(/background daemon/);
  });
  it("a resolved host without ITERM_SESSION_ID is accepted", async () => {
    await expect(openVerifiedPane(dir, config, "w-res", TERM, {}, ops, seam({ split: "ok" }))).resolves.toContain("S1");
  });
});

describe("openVerifiedPane with an inherited ITERM_SESSION_ID that died with its terminal", () => {
  const STALE = "w0t0p0:53AD0E31-0000-4000-8000-000000000000";
  it("opens in the live host the tty lookup found", async () => {
    const s = seam({ split: "ok" });
    await expect(openVerifiedPane(dir, config, "w-stale", TERM, { ITERM_SESSION_ID: STALE } as NodeJS.ProcessEnv, ops, s)).resolves.toContain("S1");
    expect(s.splits).toBe(1);
  });
  it("is refused when no live host is found", async () => {
    const s = seam({ split: "ok" });
    await expect(openVerifiedPane(dir, config, "w-stale2", "", { ITERM_SESSION_ID: STALE } as NodeJS.ProcessEnv, ops, s)).rejects.toThrow(/not a live iTerm2 session/);
    expect(s.splits).toBe(0);
  });
});
