/**
 * `pai audit tokens skills` — token cost of the whole skill/command/plugin
 * catalogue: every `SKILL.md` under ~/.claude/skills and ~/.claude/plugins,
 * plus every command under ~/.claude/commands, rendered as the one-line
 * `- name: description` entry Claude Code loads into context for each.
 *
 * Two failure modes matter more than the raw total: the same real file
 * reachable through two paths (a plugin's marketplaces/ checkout and its
 * cache/ install both point at one file), and two different real files that
 * collide on name (a skill and a command both called "Sessions") — the first
 * wastes nothing but must not be double-counted, the second silently shadows
 * one of the two in whichever catalogue order Claude Code loads them.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { countTokens, TOKEN_ENCODING } from "./tokens.js";

export type CatalogueSource = "skills" | "commands" | "plugins";

export interface CatalogueEntry {
  name: string;
  description: string;
  source: CatalogueSource;
  path: string;
  tokens: number;
  /** Always true for skills/commands; for plugins, whether `enabledPlugins` turns it on. */
  enabled: boolean;
  /** Set on a plugin entry whose derived id has no matching `enabledPlugins` key. */
  status?: "unknown";
}

export interface DuplicateGroup {
  name: string;
  paths: string[];
}

export interface SkillsReport {
  encoding: string;
  entries: CatalogueEntry[];
  total: number;
  totalsBySource: Record<CatalogueSource, number>;
  countsBySource: Record<CatalogueSource, number>;
  /** Sum of `tokens` for entries that are actually loaded into a session (enabled plugins + all skills/commands). */
  enabledTotal: number;
  enabledTotalsBySource: Record<CatalogueSource, number>;
  duplicates: DuplicateGroup[];
}

/** Recursively collect every file under `dir` whose basename satisfies `matches`. */
function findFilesRecursive(dir: string, matches: (name: string) => boolean): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findFilesRecursive(full, matches));
    } else if (entry.isFile() && matches(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

interface RawFile {
  path: string;
  source: CatalogueSource;
}

/**
 * `<skillsDir>/*\/SKILL.md`, one level deep only — this is what Claude Code
 * actually loads. `readdirSync(withFileTypes)` reports a symlinked skill
 * directory as neither file nor directory, so entries are resolved with
 * `statSync` (which follows symlinks) instead of trusting `Dirent`.
 */
function findTopLevelSkillFiles(skillsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries) {
    const dir = join(skillsDir, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const skillFile = join(dir, "SKILL.md");
    if (existsSync(skillFile)) found.push(skillFile);
  }
  return found;
}

/** Every SKILL.md/*.md the three catalogue roots contribute, source-tagged. */
export function findCatalogueFiles(claudeDir: string): RawFile[] {
  const found: RawFile[] = [];
  for (const path of findTopLevelSkillFiles(join(claudeDir, "skills"))) {
    found.push({ path, source: "skills" });
  }
  for (const path of findFilesRecursive(join(claudeDir, "commands"), (n) => n.endsWith(".md"))) {
    found.push({ path, source: "commands" });
  }
  for (const path of findFilesRecursive(join(claudeDir, "plugins"), (n) => n === "SKILL.md")) {
    found.push({ path, source: "plugins" });
  }
  return found;
}

/** Strip a single layer of matching quotes ("..." or '...') from a trimmed value. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

interface Frontmatter {
  name: string | null;
  description: string;
}

/** Parse the `name:`/`description:` frontmatter fields out of a skill/command file. */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const fm = match ? match[1] : "";
  const nameMatch = /^name:\s*(.+)$/m.exec(fm);
  const descMatch = /(?:^|\n)description:\s*(.+?)(?=\n\w[\w-]*:|$)/s.exec(fm);
  return {
    name: nameMatch ? unquote(nameMatch[1].trim()) : null,
    description: descMatch ? unquote(descMatch[1].trim()) : "",
  };
}

function nameFallback(path: string, source: CatalogueSource): string {
  if (source === "commands") return basename(path).replace(/\.md$/, "");
  return basename(dirname(path));
}

/** Build one catalogue entry from a file, deriving its name/description/tokens. */
function readEntry(path: string, source: CatalogueSource): CatalogueEntry {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    /* unreadable file: treat as an empty entry rather than throwing */
  }
  const fm = parseFrontmatter(text);
  const name = fm.name ?? nameFallback(path, source);
  const line = `- ${name}: ${fm.description}`;
  return { name, description: fm.description, source, path, tokens: countTokens(line), enabled: true };
}

interface EnabledPluginsSettings {
  enabledPlugins?: Record<string, boolean>;
}

/** `enabledPlugins` map from settings.json, or `{}` if the file is missing/unreadable. */
function readEnabledPlugins(settingsPath: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as EnabledPluginsSettings;
    return parsed.enabledPlugins ?? {};
  } catch {
    return {};
  }
}

/** `<relative-to-root>` split on the platform separator, or null if `path` is not under `root`. */
function pathUnder(root: string, path: string): string[] | null {
  const rel = relative(root, path);
  if (rel.startsWith("..")) return null;
  return rel.split(sep);
}

interface PluginStatus {
  id: string;
  enabled: boolean;
  status?: "unknown";
  /** Identifies "the same plugin file reached through cache/ or marketplaces/" for enabled-token dedup. */
  dedupeKey: string;
}

/**
 * A cache install is `plugins/cache/<marketplace>/<plugin>/<version>/...`, so its id is exact.
 * A marketplace checkout is `plugins/marketplaces/<marketplace>/...` with no plugin segment, so
 * it can only be matched by marketplace name against whichever `enabledPlugins` key ends in
 * `@<marketplace>` — good enough for the single-plugin-per-marketplace installs this audits today.
 */
function resolvePluginStatus(claudeDir: string, path: string, enabledPlugins: Record<string, boolean>): PluginStatus {
  const cacheParts = pathUnder(join(claudeDir, "plugins", "cache"), path);
  if (cacheParts && cacheParts.length >= 4) {
    const [marketplace, plugin, , ...suffix] = cacheParts;
    const id = `${plugin}@${marketplace}`;
    const known = id in enabledPlugins;
    return {
      id,
      enabled: known && enabledPlugins[id] === true,
      status: known ? undefined : "unknown",
      dedupeKey: `${id}::${suffix.join("/")}`,
    };
  }

  const marketplaceParts = pathUnder(join(claudeDir, "plugins", "marketplaces"), path);
  if (marketplaceParts && marketplaceParts.length >= 2) {
    const [marketplace, ...suffix] = marketplaceParts;
    const matchKey = Object.keys(enabledPlugins).find((k) => k.endsWith(`@${marketplace}`));
    if (matchKey) {
      return {
        id: matchKey,
        enabled: enabledPlugins[matchKey] === true,
        dedupeKey: `${matchKey}::${suffix.join("/")}`,
      };
    }
    return {
      id: `unknown@${marketplace}`,
      enabled: false,
      status: "unknown",
      dedupeKey: `unknown@${marketplace}::${suffix.join("/")}`,
    };
  }

  return { id: path, enabled: false, status: "unknown", dedupeKey: path };
}

/** Group entries by case-insensitive name; only groups with >1 real path. */
export function findDuplicates(entries: CatalogueEntry[]): DuplicateGroup[] {
  const byName = new Map<string, Set<string>>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key)!.add(entry.path);
  }
  const duplicates: DuplicateGroup[] = [];
  for (const [name, paths] of byName) {
    if (paths.size > 1) duplicates.push({ name, paths: [...paths] });
  }
  return duplicates.sort((a, b) => a.name.localeCompare(b.name));
}

export function auditSkills(
  claudeDir: string = join(homedir(), ".claude"),
  settingsPath: string = join(claudeDir, "settings.json")
): SkillsReport {
  const rawFiles = findCatalogueFiles(claudeDir);

  const seenReal = new Set<string>();
  const deduped: RawFile[] = [];
  for (const file of rawFiles) {
    let real = file.path;
    try {
      real = realpathSync(file.path);
    } catch {
      /* keep the original path if it vanished mid-scan */
    }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    deduped.push(file);
  }

  const enabledPlugins = readEnabledPlugins(settingsPath);
  const entries = deduped.map((f) => readEntry(f.path, f.source));
  const dedupeKeys = new Map<string, string>();
  for (const entry of entries) {
    if (entry.source !== "plugins") continue;
    const status = resolvePluginStatus(claudeDir, entry.path, enabledPlugins);
    entry.enabled = status.enabled;
    entry.status = status.status;
    dedupeKeys.set(entry.path, status.dedupeKey);
  }

  const totalsBySource: Record<CatalogueSource, number> = { skills: 0, commands: 0, plugins: 0 };
  const countsBySource: Record<CatalogueSource, number> = { skills: 0, commands: 0, plugins: 0 };
  const enabledTotalsBySource: Record<CatalogueSource, number> = { skills: 0, commands: 0, plugins: 0 };
  const seenEnabledPluginKeys = new Set<string>();
  for (const entry of entries) {
    totalsBySource[entry.source] += entry.tokens;
    countsBySource[entry.source] += 1;
    if (!entry.enabled) continue;
    if (entry.source !== "plugins") {
      enabledTotalsBySource[entry.source] += entry.tokens;
      continue;
    }
    const dedupeKey = dedupeKeys.get(entry.path)!;
    if (seenEnabledPluginKeys.has(dedupeKey)) continue;
    seenEnabledPluginKeys.add(dedupeKey);
    enabledTotalsBySource.plugins += entry.tokens;
  }

  return {
    encoding: TOKEN_ENCODING,
    entries,
    total: entries.reduce((sum, e) => sum + e.tokens, 0),
    totalsBySource,
    countsBySource,
    enabledTotal: enabledTotalsBySource.skills + enabledTotalsBySource.commands + enabledTotalsBySource.plugins,
    enabledTotalsBySource,
    duplicates: findDuplicates(entries),
  };
}

export function topByTokens(report: SkillsReport, n: number): CatalogueEntry[] {
  return [...report.entries].sort((a, b) => b.tokens - a.tokens).slice(0, n);
}

export const SKILL_CATALOGUE_AMBER = 3000;
export const SKILL_CATALOGUE_RED = 6000;
