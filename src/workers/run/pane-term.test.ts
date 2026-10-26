import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launchPane = vi.fn();
vi.mock("../pane-launch.js", () => ({ launchPane: (o: unknown) => launchPane(o), noTerminalReasons: new Map() }));
const resolveHostSession = vi.fn();
vi.mock("../pane.js", async (orig) => ({ ...(await orig<typeof import("../pane.js")>()), resolveHostSession: () => resolveHostSession(), headlessAllowed: () => null }));

import { paneHandles, requireVisiblePane, runTerm } from "./pane-handles.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-term-"));
  launchPane.mockReset();
  resolveHostSession.mockReset().mockResolvedValue({ uid: "", term: "", via: "none" });
});
afterEach(() => {
  paneHandles.clear();
  rmSync(dir, { recursive: true, force: true });
});

describe("a restart's pane anchor", () => {
  it("the inherited terminal identity is the anchor; this process's own lookup is not consulted", async () => {
    expect(await runTerm("w0t0p0:UUID-1")).toBe("w0t0p0:UUID-1");
    expect(resolveHostSession).not.toHaveBeenCalled();
  });

  it("an inherited term opens the pane there, in a process with no terminal of its own", async () => {
    launchPane.mockResolvedValue({ where: "split", start: vi.fn() });
    const term = await runTerm("w0t0p0:UUID-1");
    const opened = await requireVisiblePane(dir, { panes: { required: true } } as never, "w2", term, undefined, false, join(dir, "ledger.log"));
    expect(opened).toBe(true);
    expect(launchPane.mock.calls[0]![0]).toMatchObject({ id: "w2", term: "w0t0p0:UUID-1" });
  });

  it("without an inherited term the process's own host session decides (none: the pane rule still refuses)", async () => {
    expect(await runTerm(undefined)).toBe("");
    expect(resolveHostSession).toHaveBeenCalled();
    launchPane.mockResolvedValue(null);
    await expect(requireVisiblePane(dir, { panes: { required: true } } as never, "w3", "", undefined, false, join(dir, "ledger.log"))).rejects.toThrow(/no pane/);
  });
});
