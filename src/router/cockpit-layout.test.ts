import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cockpitLayout } from "./cockpit-layout.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";
import { paiConfigFilePath } from "../daemon/config.js";

const REMOVED = [
  "gridCols", "gridBreakpointPx", "minSectionPx", "providerTileMinPx", "runtimeCardMinPx",
  "tilesWideBreakpointPx", "tilesWideCols", "tilesNarrowCols", "tilesOneColBreakpointPx",
  "bigDonutSizePx", "tokensChartWidthPx", "tokensChartHeightPx", "powerChartWidthPx",
  "powerChartHeightPx", "dailyChartWidthPx", "dailyChartHeightPx", "chartResizeSlackPx",
  "chartResizeDebounceMs", "confirmMs", "foldDefaultKind", "rows", "maxPerRow", "touchPressMs",
  "edgeScrollPx",
];

describe("cockpit layout: removed keys", () => {
  let dir = "";
  const prev = process.env.PAI_CONFIG_FILE;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-cockpit-layout-rm-"));
    process.env.PAI_CONFIG_FILE = join(dir, "config.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.PAI_CONFIG_FILE;
    else process.env.PAI_CONFIG_FILE = prev;
    vi.restoreAllMocks();
  });

  it("the shipped defaults no longer carry any removed key", () => {
    const router = effectiveMainConfig(paiConfigFilePath()).router as { cockpit: { layout: Record<string, unknown> } };
    for (const k of REMOVED) expect(router.cockpit.layout).not.toHaveProperty(k);
  });

  it("a user config that still sets removed keys neither crashes nor changes the layout, and is logged once", () => {
    const before = cockpitLayout();
    writeFileSync(
      join(dir, "config.yaml"),
      "router:\n  cockpit:\n    layout:\n" + REMOVED.filter((k) => k !== "rows").map((k) => `      ${k}: 7`).join("\n") + "\n      rows: [[a, b]]\n",
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = cockpitLayout();
    cockpitLayout();
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty("rows");
    const lines = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("ignoring removed keys"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("gridBreakpointPx");
  });
});
