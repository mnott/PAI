import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleIdeaMaterialize } from "./latent-ideas.js";

let root: string;
let vault: string;
beforeEach(() => {
  root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "idea-mat-"));
  vault = join(root, "vault");
  mkdirSync(vault);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const params = (folder: string, title = "Idea") => ({
  idea_label: "l",
  title,
  folder,
  source_paths: ["a/b.md"],
  project_id: 1,
});

describe("handleIdeaMaterialize containment", () => {
  it("writes inside the vault", () => {
    const r = handleIdeaMaterialize(params("Ideas"), vault);
    expect(r.vault_path).toBe("Ideas/Idea.md");
    expect(existsSync(join(vault, "Ideas", "Idea.md"))).toBe(true);
  });

  it("refuses a ../ folder that escapes the vault", () => {
    expect(() => handleIdeaMaterialize(params("../outside"), vault)).toThrow(/escapes the vault/);
    expect(existsSync(join(root, "outside"))).toBe(false);
  });

  it("refuses a folder reached through a symlink out of the vault", async () => {
    const { symlinkSync } = await import("node:fs");
    const out = join(root, "out");
    mkdirSync(out);
    symlinkSync(out, join(vault, "link"));
    expect(() => handleIdeaMaterialize(params("link/sub"), vault)).toThrow(/escapes the vault/);
    expect(existsSync(join(out, "sub"))).toBe(false);
  });

  it("refuses to overwrite an existing note", () => {
    writeFileSync(join(vault, "Idea.md"), "mine");
    expect(() => handleIdeaMaterialize(params(""), vault)).toThrow(/already exists/);
    expect(readFileSync(join(vault, "Idea.md"), "utf8")).toBe("mine");
  });
});
