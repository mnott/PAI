import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = { enabled: true };
vi.mock("../obsidian/enabled.js", () => ({ obsidianEnabled: () => state.enabled }));

import { obsidianMarkerPath, runObsidianSyncIfDue } from "./obsidian-sync.js";
import { resetQuietForTests, setQuietSourceForTests } from "./quiet.js";

let home: string;
let prevHome: string | undefined;
const touch = (offsetMs = 0) => {
  writeFileSync(obsidianMarkerPath(), "");
  const t = new Date(Date.now() + offsetMs);
  utimesSync(obsidianMarkerPath(), t, t);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-obs-daemon-"));
  prevHome = process.env.PAI_HOME;
  process.env.PAI_HOME = home;
  state.enabled = true;
  resetQuietForTests();
  setQuietSourceForTests(() => undefined);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = prevHome;
  setQuietSourceForTests(null);
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("daemon obsidian sync job", () => {
  it("does nothing without a marker", async () => {
    const run = vi.fn(async () => {});
    expect(await runObsidianSyncIfDue(run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs once per marker change", async () => {
    const run = vi.fn(async () => {});
    touch(-5_000);
    expect(await runObsidianSyncIfDue(run)).toBe(true);
    expect(await runObsidianSyncIfDue(run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    touch(5_000);
    expect(await runObsidianSyncIfDue(run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("is single-flight", async () => {
    touch(-5_000);
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (release = r)));
    const first = runObsidianSyncIfDue(run);
    expect(await runObsidianSyncIfDue(run)).toBe(false);
    release();
    await first;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("is deferred by quiet mode and does nothing when disabled", async () => {
    const run = vi.fn(async () => {});
    touch(-5_000);
    setQuietSourceForTests(() => ({ on: true }));
    expect(await runObsidianSyncIfDue(run)).toBe(false);
    setQuietSourceForTests(() => undefined);
    state.enabled = false;
    expect(await runObsidianSyncIfDue(run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    state.enabled = true;
    expect(await runObsidianSyncIfDue(run)).toBe(true);
  });
});
