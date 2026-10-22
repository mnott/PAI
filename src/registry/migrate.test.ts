import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateFromJson, buildEncodedDirMap, slugify, fallbackSlug } from "./migrate.js";
import type { RegistryBackend } from "../storage/registry-interface.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-migrate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fakeBackend() {
  const projects: Array<{ baseSlug: string; rootPath: string; encodedDir: string }> = [];
  const backend = {
    createProjectWithSlugRetry: async (p: { baseSlug: string; rootPath: string; encodedDir: string }) => {
      projects.push(p);
      return { id: projects.length, created: true };
    },
    upsertSessionIfAbsent: async () => false,
  } as unknown as RegistryBackend;
  return { backend, projects };
}

async function run(content: unknown) {
  const file = join(tmp(), "session-registry.json");
  writeFileSync(file, JSON.stringify(content), "utf8");
  const { backend, projects } = fakeBackend();
  const result = await migrateFromJson(backend, file);
  return { result, projects, file };
}

describe("migrateFromJson formats", () => {
  it("imports list-format projects, no bogus 'projects' project", async () => {
    const root = tmp();
    const { projects, file } = await run({
      projects: [{ encoded_dir: "-nonexistent-x", original_path: root }],
    });
    expect(projects.map((p) => p.encodedDir)).toEqual(["-nonexistent-x"]);
    expect(projects[0].rootPath).toBe(root);
    expect(buildEncodedDirMap(file).get("-nonexistent-x")).toBe(root);
  });

  it("imports object-keyed projects and skips 'version'", async () => {
    const root = tmp();
    const { projects } = await run({
      version: 1,
      "-nonexistent-y": { original_path: root },
    });
    expect(projects.map((p) => p.encodedDir)).toEqual(["-nonexistent-y"]);
  });
});

describe("slugs", () => {
  it("falls back to a stable hash slug for non-ASCII names", async () => {
    expect(slugify("/x/日本語")).toBe("");
    expect(fallbackSlug("/x/日本語")).toMatch(/^project-[0-9a-f]{8}$/);
    expect(fallbackSlug("/x/日本語")).toBe(fallbackSlug("/x/日本語"));
    const { projects } = await run({ "-nonexistent-z": { original_path: "/x/日本語" } });
    expect(projects[0].baseSlug).toBe(fallbackSlug(projects[0].rootPath));
  });
});
