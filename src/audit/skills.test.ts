import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSkills, findCatalogueFiles, findDuplicates, parseFrontmatter } from "./skills.js";
import { countTokens } from "./tokens.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-skills-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeSettings(root: string, enabledPlugins: Record<string, boolean>): void {
  writeFileSync(join(root, "settings.json"), JSON.stringify({ enabledPlugins }), "utf8");
}

function writeCachePlugin(
  root: string,
  marketplace: string,
  plugin: string,
  version: string,
  skillName: string,
  frontmatter: Record<string, string>
): string {
  const dir = join(root, "plugins", "cache", marketplace, plugin, version, "skills", skillName);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\n${fm}\n---\n\n# ${skillName}\n`, "utf8");
  return path;
}

function writeMarketplacePlugin(
  root: string,
  marketplace: string,
  skillName: string,
  frontmatter: Record<string, string>
): string {
  const dir = join(root, "plugins", "marketplaces", marketplace, "skills", skillName);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\n${fm}\n---\n\n# ${skillName}\n`, "utf8");
  return path;
}

function writeSkill(root: string, name: string, frontmatter: Record<string, string>): string {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\n${fm}\n---\n\n# ${name}\n`, "utf8");
  return path;
}

describe("parseFrontmatter", () => {
  it("reads name and a single-line description", () => {
    const fm = parseFrontmatter('---\nname: Foo\ndescription: "does a thing"\n---\n\nbody');
    expect(fm.name).toBe("Foo");
    expect(fm.description).toBe("does a thing");
  });

  it("reads a multi-line description up to the next key", () => {
    const text = "---\nname: Foo\ndescription: line one\nline two\nallowed-tools: Bash\n---\n";
    const fm = parseFrontmatter(text);
    expect(fm.description).toBe("line one\nline two");
  });

  it("returns null name and empty description when there is no frontmatter", () => {
    const fm = parseFrontmatter("just a plain command file\n");
    expect(fm.name).toBeNull();
    expect(fm.description).toBe("");
  });
});

describe("findCatalogueFiles", () => {
  it("finds SKILL.md one level under skills/, *.md under commands/, and SKILL.md at any depth under plugins/", () => {
    const root = newDir();
    writeSkill(root, "Foo", { name: "Foo", description: "a skill" });
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", "bar.md"), "run bar", "utf8");
    mkdirSync(join(root, "plugins", "cache", "x", "1.0.0", "skills", "baz"), { recursive: true });
    writeFileSync(
      join(root, "plugins", "cache", "x", "1.0.0", "skills", "baz", "SKILL.md"),
      "---\nname: Baz\ndescription: nested\n---\n",
      "utf8"
    );

    const files = findCatalogueFiles(root);
    expect(files.some((f) => f.source === "skills" && f.path.endsWith("Foo/SKILL.md"))).toBe(true);
    expect(files.some((f) => f.source === "commands" && f.path.endsWith("bar.md"))).toBe(true);
    expect(files.some((f) => f.source === "plugins" && f.path.endsWith("baz/SKILL.md"))).toBe(true);
  });
});

describe("auditSkills", () => {
  it("counts one catalogue-line-token entry per file and sums a total", () => {
    const root = newDir();
    writeSkill(root, "Foo", { name: "Foo", description: "does a thing" });
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", "bar.md"), "run bar", "utf8");

    const report = auditSkills(root);
    expect(report.entries).toHaveLength(2);
    const fooEntry = report.entries.find((e) => e.name === "Foo")!;
    expect(fooEntry.tokens).toBe(countTokens("- Foo: does a thing"));
    const barEntry = report.entries.find((e) => e.name === "bar")!;
    expect(barEntry.source).toBe("commands");
    expect(barEntry.description).toBe("");
    expect(report.total).toBe(fooEntry.tokens + barEntry.tokens);
    expect(report.totalsBySource.skills).toBe(fooEntry.tokens);
    expect(report.totalsBySource.commands).toBe(barEntry.tokens);
  });

  it("follows a symlinked skill directory, not just a symlinked file inside it", () => {
    const root = newDir();
    const realRoot = newDir();
    const realDir = join(realRoot, "RealSkill");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "SKILL.md"), "---\nname: RealSkill\ndescription: symlinked dir\n---\n", "utf8");
    mkdirSync(join(root, "skills"), { recursive: true });
    symlinkSync(realDir, join(root, "skills", "RealSkill"));

    const files = findCatalogueFiles(root);
    expect(files.some((f) => f.source === "skills" && f.path.endsWith("RealSkill/SKILL.md"))).toBe(true);

    const report = auditSkills(root);
    expect(report.entries.some((e) => e.name === "RealSkill")).toBe(true);
  });

  it("dedupes the same real file reached through a symlink", () => {
    const root = newDir();
    const real = writeSkill(root, "Foo", { name: "Foo", description: "does a thing" });
    const linkedSkillDir = join(root, "skills", "FooLink");
    mkdirSync(linkedSkillDir, { recursive: true });
    symlinkSync(real, join(linkedSkillDir, "SKILL.md"));

    const report = auditSkills(root);
    expect(report.entries).toHaveLength(1);
  });

  it("flags case-insensitive duplicate names across different real files", () => {
    const root = newDir();
    writeSkill(root, "Sessions", { name: "Sessions", description: "navigate sessions" });
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", "sessions.md"), "run sessions", "utf8");

    const report = auditSkills(root);
    const dup = findDuplicates(report.entries).find((d) => d.name === "sessions");
    expect(dup).toBeDefined();
    expect(dup!.paths).toHaveLength(2);
  });

  it("falls back to the file/dir name when there is no name frontmatter", () => {
    const root = newDir();
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", "plain.md"), "no frontmatter here", "utf8");

    const report = auditSkills(root);
    expect(report.entries[0].name).toBe("plain");
  });
});

describe("auditSkills — enabledPlugins", () => {
  it("counts a plugin whose id maps to true in enabledPlugins", () => {
    const root = newDir();
    writeSettings(root, { "on-plugin@on-mp": true });
    writeCachePlugin(root, "on-mp", "on-plugin", "1.0.0", "foo", { name: "Foo", description: "an enabled plugin skill" });

    const report = auditSkills(root);
    const entry = report.entries.find((e) => e.name === "Foo")!;
    expect(entry.enabled).toBe(true);
    expect(entry.status).toBeUndefined();
    expect(report.enabledTotalsBySource.plugins).toBe(entry.tokens);
    expect(report.enabledTotal).toBe(entry.tokens);
  });

  it("excludes a plugin whose id maps to false in enabledPlugins", () => {
    const root = newDir();
    writeSettings(root, { "off-plugin@off-mp": false });
    writeCachePlugin(root, "off-mp", "off-plugin", "1.0.0", "bar", { name: "Bar", description: "a disabled plugin skill" });

    const report = auditSkills(root);
    const entry = report.entries.find((e) => e.name === "Bar")!;
    expect(entry.enabled).toBe(false);
    expect(report.enabledTotalsBySource.plugins).toBe(0);
    expect(report.enabledTotal).toBe(0);
    expect(report.total).toBe(entry.tokens);
  });

  it("marks a plugin id absent from enabledPlugins as unknown and not enabled", () => {
    const root = newDir();
    writeSettings(root, {});
    writeCachePlugin(root, "mystery-mp", "mystery-plugin", "1.0.0", "baz", { name: "Baz", description: "unregistered plugin skill" });

    const report = auditSkills(root);
    const entry = report.entries.find((e) => e.name === "Baz")!;
    expect(entry.enabled).toBe(false);
    expect(entry.status).toBe("unknown");
  });

  it("dedupes tokens once when the same enabled plugin id appears via both cache/ and marketplaces/", () => {
    const root = newDir();
    writeSettings(root, { "dup-plugin@dup-mp": true });
    writeCachePlugin(root, "dup-mp", "dup-plugin", "1.0.0", "shared", { name: "Shared", description: "same skill twice" });
    writeMarketplacePlugin(root, "dup-mp", "shared", { name: "Shared", description: "same skill twice" });

    const report = auditSkills(root);
    const entries = report.entries.filter((e) => e.name === "Shared");
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.enabled)).toBe(true);
    expect(report.enabledTotalsBySource.plugins).toBe(entries[0].tokens);
    expect(report.total).toBe(entries[0].tokens + entries[1].tokens);
  });

  it("always treats skills/ dir entries as loaded regardless of enabledPlugins", () => {
    const root = newDir();
    writeSettings(root, {});
    writeSkill(root, "Foo", { name: "Foo", description: "a plain skill" });

    const report = auditSkills(root);
    const entry = report.entries.find((e) => e.name === "Foo")!;
    expect(entry.enabled).toBe(true);
    expect(entry.status).toBeUndefined();
    expect(report.enabledTotalsBySource.skills).toBe(entry.tokens);
  });
});
