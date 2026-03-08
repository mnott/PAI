#!/usr/bin/env node
/**
 * Generate SKILL.md files from MCP prompt definitions.
 *
 * Sources (in order):
 *   1. src/daemon-mcp/prompts/*.ts       — PAI built-in prompts (tracked in git)
 *   2. src/daemon-mcp/prompts/custom/*.ts — User-created prompts (gitignored)
 *
 * Each prompt becomes a discoverable Claude Code skill at:
 *   dist/skills/<TitleCase>/SKILL.md
 *
 * Installation: `pai setup` or `pai skills sync` symlinks (macOS/Linux)
 * or copies (Windows) each skill directory into ~/.claude/skills/.
 *
 * With --sync: also creates/updates symlinks in ~/.claude/skills/ after
 * generating stubs. This is called automatically during `bun run build`.
 *
 * Source of truth: the TypeScript prompt files. Skills are regenerated on
 * every build — never edit the generated SKILL.md files by hand.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
} from "fs";
import { join, resolve } from "path";
import { homedir, platform } from "os";

const PROMPTS_DIR = "src/daemon-mcp/prompts";
const CUSTOM_DIR = join(PROMPTS_DIR, "custom");
const STUBS_OUT = "dist/skills";
const doSync = process.argv.includes("--sync");

// kebab-case → TitleCase for Claude Code's skill scanner
function toTitleCase(promptName) {
  return promptName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

// Extract description and full content from a prompt .ts file
function parsePrompt(filePath) {
  const src = readFileSync(filePath, "utf-8");

  // Extract the description field
  const descMatch = src.match(/description:\s*["'`]([^"'`]+)["'`]/);
  if (!descMatch) return null;
  const description = descMatch[1];

  // Extract USE WHEN line
  const useWhenMatch = src.match(/USE WHEN[^\n]+/);
  const useWhen = useWhenMatch ? useWhenMatch[0] : "";

  // Extract the full content template string
  // Match content: `...` handling escaped backticks (\`) inside
  const contentMatch = src.match(/content:\s*`((?:[^`\\]|\\[\s\S])*)`/);
  if (!contentMatch) return null;
  // Unescape template literal escapes
  const content = contentMatch[1]
    .replace(/\\`/g, "`")
    .replace(/\\\$/g, "$")
    .replace(/\\'/g, "'")
    .replace(/\\n/g, "\n");

  return { description, useWhen, content };
}

// Read export list from index.ts to get built-in prompt file names
function getBuiltinPromptNames() {
  const indexSrc = readFileSync(join(PROMPTS_DIR, "index.ts"), "utf-8");
  const names = [];
  for (const match of indexSrc.matchAll(
    /export\s+\{[^}]+\}\s+from\s+["']\.\/([^"']+)\.js["']/g
  )) {
    names.push(match[1]);
  }
  return names;
}

// Scan custom/ directory for user-created prompt files
function getCustomPromptNames() {
  if (!existsSync(CUSTOM_DIR)) return [];
  return readdirSync(CUSTOM_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => f.replace(/\.ts$/, ""));
}

// Sync symlinks: create/update symlinks in ~/.claude/skills/
function syncSymlinks(generatedNames) {
  const skillsDir = join(homedir(), ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });

  const useSymlinks = platform() !== "win32";
  let created = 0;
  let updated = 0;
  let current = 0;

  for (const name of generatedNames) {
    const source = resolve(join(STUBS_OUT, name));
    const target = join(skillsDir, name);

    // Never overwrite non-symlink directories (user's own skills)
    if (existsSync(target) && !lstatSync(target).isSymbolicLink()) {
      continue;
    }

    // Check existing symlink
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      if (resolve(readlinkSync(target)) === source) {
        current++;
        continue;
      }
      unlinkSync(target);
      updated++;
    }

    if (useSymlinks) {
      symlinkSync(source, target);
    } else {
      mkdirSync(target, { recursive: true });
      writeFileSync(
        join(target, "SKILL.md"),
        readFileSync(join(source, "SKILL.md")),
      );
    }
    created++;
  }

  // Clean up stale symlinks from old user/ location
  const oldUserDir = join(skillsDir, "user");
  if (existsSync(oldUserDir)) {
    for (const name of generatedNames) {
      const oldTarget = join(oldUserDir, name);
      if (existsSync(oldTarget) && lstatSync(oldTarget).isSymbolicLink()) {
        unlinkSync(oldTarget);
      }
    }
  }

  const parts = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (current > 0) parts.push(`${current} current`);
  console.log(`✔ Skill symlinks synced: ${parts.join(", ")}`);
}

// --- Main ---

const builtinNames = getBuiltinPromptNames();
const customNames = getCustomPromptNames();
let generated = 0;
const generatedDirNames = [];

mkdirSync(STUBS_OUT, { recursive: true });

// Process all prompts (built-in + custom)
for (const [fileName, dir] of [
  ...builtinNames.map((n) => [n, PROMPTS_DIR]),
  ...customNames.map((n) => [n, CUSTOM_DIR]),
]) {
  const filePath = join(dir, `${fileName}.ts`);
  const parsed = parsePrompt(filePath);
  if (!parsed) {
    console.warn(`⚠ Skipping ${fileName}: could not parse`);
    continue;
  }

  const dirName = toTitleCase(fileName);
  const outDir = join(STUBS_OUT, dirName);
  const outFile = join(outDir, "SKILL.md");

  mkdirSync(outDir, { recursive: true });

  const skill = [
    "---",
    `name: ${dirName}`,
    `description: "${parsed.description}. ${parsed.useWhen}"`,
    "---",
    "",
    parsed.content.trim(),
    "",
  ].join("\n");

  writeFileSync(outFile, skill);
  generatedDirNames.push(dirName);
  generated++;
}

const customLabel = customNames.length > 0 ? ` (${builtinNames.length} built-in + ${customNames.length} custom)` : "";
console.log(`✔ ${generated} skill stubs generated in ${STUBS_OUT}/${customLabel}`);

if (doSync) {
  syncSymlinks(generatedDirNames);
}
