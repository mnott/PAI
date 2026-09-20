/**
 * The PAI_DIR→ADAPTER_DIR deprecation notice used to fire on every process
 * that had PAI_DIR set at all — including the operator's own settings.json,
 * which sets PAI_DIR to exactly the default adapter root (~/.claude). That
 * must stay silent; only a PAI_DIR that actually differs from the default is
 * worth a heads-up, and even then only once per process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

// resolveAdapterDir() resolves the default (homedir()/.claude) at module
// load, so the stub has to be in place before the dynamic import below.
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_ARGV = [...process.argv];

function resetNoticeFlag(): void {
  delete (globalThis as { __paiDirNoticePrinted?: boolean }).__paiDirNoticePrinted;
}

function deprecationLines(writeSpy: ReturnType<typeof vi.spyOn>): string[] {
  return writeSpy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("PAI_DIR is deprecated"));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-paths-test-"));
  mkdirSync(join(home, ".claude", "Hooks"), { recursive: true });
  delete process.env.ADAPTER_DIR;
  delete process.env.PAI_DIR;
  delete process.env.PAI_QUIET_NOTICES;
  process.argv = [...ORIGINAL_ARGV];
  resetNoticeFlag();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
  process.argv = [...ORIGINAL_ARGV];
  resetNoticeFlag();
  vi.resetModules();
});

describe("resolveAdapterDir PAI_DIR deprecation notice", () => {
  it("stays silent when PAI_DIR equals the default adapter root", async () => {
    process.env.PAI_DIR = join(home, ".claude");
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { ADAPTER_DIR } = await import("./pai-paths.js");

    expect(ADAPTER_DIR).toBe(join(home, ".claude"));
    expect(deprecationLines(writeSpy)).toHaveLength(0);
    writeSpy.mockRestore();
  });

  it("prints exactly one line when PAI_DIR differs from the default", async () => {
    const otherAdapter = mkdtempSync(join(tmpdir(), "pai-paths-other-"));
    mkdirSync(join(otherAdapter, "Hooks"), { recursive: true });
    process.env.PAI_DIR = otherAdapter;
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { ADAPTER_DIR } = await import("./pai-paths.js");

    expect(ADAPTER_DIR).toBe(otherAdapter);
    expect(deprecationLines(writeSpy)).toHaveLength(1);

    writeSpy.mockRestore();
    rmSync(otherAdapter, { recursive: true, force: true });
  });

  it("stays silent when PAI_QUIET_NOTICES=1 even if PAI_DIR differs", async () => {
    const otherAdapter = mkdtempSync(join(tmpdir(), "pai-paths-quiet-"));
    mkdirSync(join(otherAdapter, "Hooks"), { recursive: true });
    process.env.PAI_DIR = otherAdapter;
    process.env.PAI_QUIET_NOTICES = "1";
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await import("./pai-paths.js");

    expect(deprecationLines(writeSpy)).toHaveLength(0);

    writeSpy.mockRestore();
    rmSync(otherAdapter, { recursive: true, force: true });
  });
});
