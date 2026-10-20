/**
 * shipped-defaults-resolve.test.ts — shippedDefaultsDir() finds the defaults
 * from a bundled chunk at the dist root, independent of the cwd (the launchd
 * daemon runs with cwd "/"), and throws naming every path tried otherwise.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shippedDefaultsDir } from "./shipped-defaults.js";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-defaults-"));
  tmps.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PAI_DEFAULTS_DIR;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("shippedDefaultsDir", () => {
  it("finds dist/config/defaults from a chunk at the dist root with cwd /", () => {
    delete process.env.PAI_DEFAULTS_DIR;
    const root = tmp();
    const dir = join(root, "dist", "config", "defaults");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workers.yaml"), "{}\n");
    vi.spyOn(process, "cwd").mockReturnValue("/");
    expect(shippedDefaultsDir(join(root, "dist"))).toBe(dir);
  });

  it("falls back to <package root>/dist/config/defaults from a nested module dir", () => {
    delete process.env.PAI_DEFAULTS_DIR;
    const root = tmp();
    writeFileSync(join(root, "package.json"), "{}\n");
    const dir = join(root, "dist", "config", "defaults");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workers.yaml"), "{}\n");
    const nested = join(root, "dist", "some", "deep");
    mkdirSync(nested, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue("/");
    expect(shippedDefaultsDir(nested)).toBe(dir);
  });

  it("throws listing every path tried when nothing is present", () => {
    delete process.env.PAI_DEFAULTS_DIR;
    const root = tmp();
    mkdirSync(join(root, "dist"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue("/");
    expect(() => shippedDefaultsDir(join(root, "dist"))).toThrow(
      new RegExp(`${join(root, "dist", "config", "defaults").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  });
});
