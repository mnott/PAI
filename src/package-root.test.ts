import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "./module-paths.js";

function layout(...dirs: string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pai-pkgroot-")));
  writeFileSync(join(root, "package.json"), "{}");
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  return root;
}

describe("packageRoot", () => {
  it("finds the root from a chunk directly under dist/", () => {
    const root = layout("dist");
    expect(packageRoot(pathToFileURL(join(root, "dist", "program-x.mjs")).href)).toBe(root);
  });

  it("finds the root from nested dist/cli/commands/setup and from src/", () => {
    const root = layout("dist/cli/commands/setup", "src/cli");
    expect(packageRoot(pathToFileURL(join(root, "dist/cli/commands/setup/utils.mjs")).href)).toBe(root);
    expect(packageRoot(pathToFileURL(join(root, "src/cli/program.ts")).href)).toBe(root);
  });

  it("finds the root in an npm install layout (node_modules/@scope/pkg)", () => {
    const root = layout("node_modules/@tekmidian/pai/dist");
    const pkg = join(root, "node_modules/@tekmidian/pai");
    writeFileSync(join(pkg, "package.json"), "{}");
    expect(packageRoot(pathToFileURL(join(pkg, "dist", "program-x.mjs")).href)).toBe(pkg);
  });
});
