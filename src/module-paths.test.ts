/**
 * The bug this pins: tsdown emits shared chunks directly under dist/ (e.g.
 * dist/program-abc.mjs) as well as at dist/cli/index.mjs, and a fixed
 * "../daemon/index.mjs" relative to import.meta.url is only correct for one of
 * those two depths. resolveFromModule must find the same target file from either.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFromModule } from "./module-paths.js";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "pai-module-paths-"));
  mkdirSync(join(root, "dist", "daemon"), { recursive: true });
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  mkdirSync(join(root, "docker"), { recursive: true });
  writeFileSync(join(root, "dist", "daemon", "index.mjs"), "// daemon");
  writeFileSync(join(root, "docker", "migrate-sqlite.ts"), "// migrate");
  return root;
}

describe("resolveFromModule", () => {
  it("finds dist/daemon/index.mjs from a chunk emitted directly in dist/", () => {
    const root = makeFixture();
    try {
      const moduleUrl = pathToFileURL(join(root, "dist", "program-abc.mjs")).href;
      expect(resolveFromModule(moduleUrl, "dist/daemon/index.mjs")).toBe(
        join(root, "dist", "daemon", "index.mjs")
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds dist/daemon/index.mjs from a chunk emitted at dist/cli/", () => {
    const root = makeFixture();
    try {
      const moduleUrl = pathToFileURL(join(root, "dist", "cli", "index.mjs")).href;
      expect(resolveFromModule(moduleUrl, "dist/daemon/index.mjs")).toBe(
        join(root, "dist", "daemon", "index.mjs")
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a package-root sibling of dist/ (a file excluded from the bundle)", () => {
    const root = makeFixture();
    try {
      const moduleUrl = pathToFileURL(join(root, "dist", "cli", "index.mjs")).href;
      expect(resolveFromModule(moduleUrl, "docker/migrate-sqlite.ts")).toBe(
        join(root, "docker", "migrate-sqlite.ts")
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws rather than guessing when the target does not exist", () => {
    const root = makeFixture();
    try {
      const moduleUrl = pathToFileURL(join(root, "dist", "cli", "index.mjs")).href;
      expect(() => resolveFromModule(moduleUrl, "dist/missing/index.mjs")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
