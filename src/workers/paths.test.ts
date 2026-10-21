import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultWorkersConfig } from "./config.js";
import { workersLogDir } from "./paths.js";

const saved = process.env.PAI_HOME;
const dirs: string[] = [];
afterEach(() => {
  if (saved === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = saved;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("workersLogDir", () => {
  it("a PAI_HOME override owns its logs/workers and prints no old-location hint", () => {
    const home = mkdtempSync(join(tmpdir(), "pai-paths-"));
    dirs.push(home);
    process.env.PAI_HOME = home;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(workersLogDir(defaultWorkersConfig())).toBe(join(home, "logs", "workers"));
    expect(err.mock.calls.map((c) => String(c[0])).join("")).not.toContain("old location");
  });
});
