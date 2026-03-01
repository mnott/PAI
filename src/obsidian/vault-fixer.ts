/**
 * obsidian/vault-fixer.ts — Vault link-graph issue detection and safe auto-fix
 *
 * Detects:
 *  - dead-link          : wikilinks that resolve to no known vault file
 *  - orphan             : notes with zero inbound and zero outbound links (with exemptions)
 *  - missing-parent-link: folder notes whose frontmatter does not link to their parent
 *  - dual-path-conflict : wikilinks using an alias path rather than the canonical path
 *
 * Safe auto-fix (opt-in via opts.apply):
 *  - missing-parent-link → adds `links:` frontmatter entry
 *  - dual-path-conflict  → replaces alias wikilink text with canonical target
 *
 * SAFETY INVARIANTS (never violated):
 *  - Never deletes any content
 *  - Never touches prose — only the YAML frontmatter block (between --- delimiters)
 *  - Never writes unless opts.apply === true
 *  - Never modifies files under _archive/ paths
 *  - Always checks idempotency before applying any edit
 *  - Always preserves existing frontmatter key order
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Database } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IssueKind =
  | "dead-link"
  | "orphan"
  | "missing-parent-link"
  | "dual-path-conflict";

export interface VaultIssue {
  kind: IssueKind;
  notePath: string;
  description: string;
  autoFixable: boolean;
  suggestedEdit?: SuggestedEdit;
}

export interface SuggestedEdit {
  /** Absolute path to file that will be modified */
  targetPath: string;
  operation: "add-frontmatter-link" | "replace-wikilink";
  /** e.g. "links" — used when operation is add-frontmatter-link */
  frontmatterKey?: string;
  /** e.g. "[[02 - Philosophy/01]]" — value to add */
  wikilinkText?: string;
  /** For replace-wikilink: the exact text to find */
  oldText?: string;
  /** For replace-wikilink: the replacement text */
  newText?: string;
}

export interface VaultFixerReport {
  timestamp: string;
  vaultPath: string;
  summary: {
    totalNotes: number;
    totalLinks: number;
    deadLinks: number;
    orphans: number;
    missingParentLinks: number;
    dualPathConflicts: number;
    fixableIssues: number;
    appliedEdits: number;
  };
  issues: VaultIssue[];
  errors: string[];
}

export interface FixerOptions {
  /** When true, write file edits to disk */
  apply?: boolean;
  /** Restrict detection to these kinds only (default: all) */
  kinds?: IssueKind[];
  /** Cap per issue kind, default 200 */
  maxIssues?: number;
}

// ---------------------------------------------------------------------------
// Orphan exemption patterns
// ---------------------------------------------------------------------------

const ORPHAN_EXEMPT_PATTERNS: RegExp[] = [
  /^\d{4}-\d{2}-\d{2}\.md$/,                          // Daily notes: 2026-03-01.md
  /^\d{4}\s*-\s*\d{4}-\d{2}-\d{2}\s*-\s*.+\.md$/,    // Session notes: 0001 - 2026-03-01 - Foo.md
  /_index\.md$/,                                         // Index files
  /^MEMORY\.md$/i,                                       // MEMORY.md files
];

function isOrphanExempt(vaultPath: string): boolean {
  const name = basename(vaultPath);
  return ORPHAN_EXEMPT_PATTERNS.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// Folder-note detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if a vault-relative path represents a "folder note":
 * a file whose stem matches the leading token of its parent directory name.
 *
 * Examples:
 *   "02 - Philosophy/02.md"           → true  (stem "02" matches dir prefix "02")
 *   "02 - Philosophy/01 - Intro.md"   → false
 *   "Notes/README.md"                 → false
 */
function isFolderNote(vaultPath: string): boolean {
  const dir = dirname(vaultPath);
  if (dir === "." || dir === "") return false;
  const dirLeaf = basename(dir);
  const stem = basename(vaultPath, ".md");
  // Match stem against the leading token(s) of the directory name.
  // A folder note stem is typically a pure number or short code like "02".
  // The directory is typically "02 - Some Title".
  // We check: dirLeaf starts with stem followed by a space, dash, or end.
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:\\s|\\s*-|$)`).test(dirLeaf);
}

/**
 * Given a folder note path, derive the vault-relative path of its parent folder note.
 * The parent folder note lives in the grandparent directory and its stem matches
 * the leading token of that parent directory.
 *
 * Returns null if no parent folder note can be inferred (e.g. top-level folder).
 *
 * Example: "02 - Philosophy/03 - Epistemology/03.md"
 *   → parent folder is "02 - Philosophy"
 *   → parent folder note candidate: "02 - Philosophy/02.md"
 */
function deriveParentFolderNotePath(vaultPath: string): string | null {
  const dir = dirname(vaultPath);          // "02 - Philosophy/03 - Epistemology"
  const grandparent = dirname(dir);        // "02 - Philosophy"
  if (grandparent === "." || grandparent === "") return null;

  const grandparentLeaf = basename(grandparent); // "02 - Philosophy"
  // Extract leading token (numbers or letters before first space/dash)
  const match = grandparentLeaf.match(/^([^\s-]+)/);
  if (!match) return null;
  const stem = match[1];                   // "02"

  return join(grandparent, `${stem}.md`); // "02 - Philosophy/02.md"
}

// ---------------------------------------------------------------------------
// Frontmatter parser — simple string manipulation, no YAML library
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  /** True if a frontmatter block (--- ... ---) was found */
  hasFrontmatter: boolean;
  /** Raw content of the YAML block (between the two --- lines, excluding delimiters) */
  yamlBlock: string;
  /** Content after the closing --- */
  body: string;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  // Frontmatter must start at the very beginning of the file.
  if (!content.startsWith("---")) {
    return { hasFrontmatter: false, yamlBlock: "", body: content };
  }

  // Find the closing ---
  const afterOpen = content.indexOf("\n", 0);
  if (afterOpen === -1) {
    return { hasFrontmatter: false, yamlBlock: "", body: content };
  }

  const closeIdx = content.indexOf("\n---", afterOpen);
  if (closeIdx === -1) {
    return { hasFrontmatter: false, yamlBlock: "", body: content };
  }

  const yamlBlock = content.slice(afterOpen + 1, closeIdx);
  // Body starts after the closing ---\n
  const bodyStart = closeIdx + 4; // skip "\n---"
  const body = content.slice(bodyStart).replace(/^\n/, ""); // skip one trailing newline

  return { hasFrontmatter: true, yamlBlock, body };
}

function reconstructFile(yamlBlock: string, body: string): string {
  return `---\n${yamlBlock}\n---\n${body}`;
}

/**
 * Parse a YAML array value from a single line like:
 *   links: ["[[foo]]", "[[bar]]"]
 *   links: ['[[foo]]']
 *   links: []
 * or from a block sequence that starts immediately after the key line.
 *
 * Returns the items as strings (stripped of surrounding quotes) or null if
 * the key isn't present in the yaml block.
 */
interface YamlKeyInfo {
  /** Whether the key was found */
  found: boolean;
  /** Line index (within yamlLines) where the key declaration is */
  keyLineIdx: number;
  /** True if value is inline array  (links: [...]) */
  isInline: boolean;
  /** True if value is block sequence (- item lines follow) */
  isBlock: boolean;
  /** Parsed string items (wikilink texts, already stripped of quotes) */
  items: string[];
  /** Number of lines consumed by the value (1 for inline, N for block) */
  valueLineCount: number;
}

function parseYamlKey(yamlBlock: string, key: string): YamlKeyInfo {
  const lines = yamlBlock.split("\n");
  const prefix = `${key}:`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(prefix)) continue;

    const rest = line.slice(prefix.length).trim();

    // Inline array: links: ["[[foo]]", "[[bar]]"]
    if (rest.startsWith("[")) {
      const items = parseInlineYamlArray(rest);
      return {
        found: true,
        keyLineIdx: i,
        isInline: true,
        isBlock: false,
        items,
        valueLineCount: 1,
      };
    }

    // Scalar string: links: "[[foo]]"  or  links: [[foo]]
    if (rest.length > 0 && !rest.startsWith("#")) {
      const value = rest.replace(/^["']|["']$/g, "");
      return {
        found: true,
        keyLineIdx: i,
        isInline: false,
        isBlock: false,
        items: [value],
        valueLineCount: 1,
      };
    }

    // Block sequence: lines following start with "  - "
    if (rest === "" || rest.startsWith("#")) {
      const blockItems: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s/.test(lines[j])) {
        const item = lines[j].replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, "");
        blockItems.push(item);
        j++;
      }
      return {
        found: true,
        keyLineIdx: i,
        isInline: false,
        isBlock: true,
        items: blockItems,
        valueLineCount: j - i,
      };
    }
  }

  return {
    found: false,
    keyLineIdx: -1,
    isInline: false,
    isBlock: false,
    items: [],
    valueLineCount: 0,
  };
}

/** Parse ["[[foo]]", "[[bar]]"] into ["[[foo]]", "[[bar]]"] */
function parseInlineYamlArray(text: string): string[] {
  // Strip outer brackets
  const inner = text.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];

  const items: string[] = [];
  // Split on comma, respecting quoted strings
  const re = /(?:"([^"]*?)"|'([^']*?)'|([^,\s][^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const item = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (item) items.push(item);
  }
  return items;
}

/**
 * Add or update a YAML key to include a new wikilink value.
 * Returns updated yamlBlock string.
 *
 * Strategy:
 *  - If key not present: append "key:\n  - value" to the block
 *  - If key is inline array: append value (idempotent check first)
 *  - If key is scalar: convert to inline array
 *  - If key is block sequence: append "  - value" after last item
 */
function addToYamlKey(yamlBlock: string, key: string, value: string): string {
  const info = parseYamlKey(yamlBlock, key);

  if (!info.found) {
    // Append new key at end of YAML block
    const trimmed = yamlBlock.trimEnd();
    return `${trimmed}\n${key}:\n  - "${value}"\n`;
  }

  // Idempotency: already contains this value?
  if (info.items.includes(value)) return yamlBlock;

  const lines = yamlBlock.split("\n");

  if (info.isInline) {
    // Rebuild inline array with new value
    const newItems = [...info.items, value];
    const arrayStr = newItems.map((v) => `"${v}"`).join(", ");
    lines[info.keyLineIdx] = `${key}: [${arrayStr}]`;
    return lines.join("\n");
  }

  if (info.isBlock) {
    // Insert after last block item
    const insertAt = info.keyLineIdx + info.valueLineCount;
    lines.splice(insertAt, 0, `  - "${value}"`);
    return lines.join("\n");
  }

  // Scalar → convert to inline array
  const newItems = [...info.items, value];
  const arrayStr = newItems.map((v) => `"${v}"`).join(", ");
  lines[info.keyLineIdx] = `${key}: [${arrayStr}]`;
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Safe file edit primitives
// ---------------------------------------------------------------------------

const ARCHIVE_PATH_RE = /[\\/]_archive[\\/]/i;

function isArchived(absPath: string): boolean {
  return ARCHIVE_PATH_RE.test(absPath);
}

/**
 * Add a wikilink value to a frontmatter key in a markdown file.
 * Reads the file, modifies ONLY the frontmatter block, writes back.
 *
 * Safety:
 *  - Checks for _archive/ in path
 *  - Never modifies prose
 *  - Idempotent (skips if already present)
 *
 * Returns true if a change was written, false if skipped.
 */
function addFrontmatterLink(
  absPath: string,
  key: string,
  wikilinkText: string,
): boolean {
  if (isArchived(absPath)) return false;

  const content = readFileSync(absPath, "utf8");
  const { hasFrontmatter, yamlBlock, body } = parseFrontmatter(content);

  if (hasFrontmatter) {
    const updated = addToYamlKey(yamlBlock, key, wikilinkText);
    if (updated === yamlBlock) return false; // idempotent — nothing changed
    const newContent = reconstructFile(updated, body);
    writeFileSync(absPath, newContent, "utf8");
    return true;
  }

  // No frontmatter — add a new one
  const newYaml = `${key}:\n  - "${wikilinkText}"`;
  const newContent = reconstructFile(newYaml, content);
  writeFileSync(absPath, newContent, "utf8");
  return true;
}

/**
 * Replace a wikilink text occurrence in a file's frontmatter.
 * Only searches within the YAML frontmatter block (between --- delimiters).
 *
 * Returns true if a change was written, false if skipped/not found.
 */
function replaceFrontmatterText(
  absPath: string,
  oldText: string,
  newText: string,
): boolean {
  if (isArchived(absPath)) return false;

  const content = readFileSync(absPath, "utf8");
  const { hasFrontmatter, yamlBlock, body } = parseFrontmatter(content);

  if (!hasFrontmatter) return false;
  if (!yamlBlock.includes(oldText)) return false;
  if (oldText === newText) return false;

  const updatedYaml = yamlBlock.split(oldText).join(newText);
  const newContent = reconstructFile(updatedYaml, body);
  writeFileSync(absPath, newContent, "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// Detection: dead links
// ---------------------------------------------------------------------------

interface DeadLinkRow {
  source_path: string;
  target_raw: string;
  line_number: number;
}

function detectDeadLinks(
  db: Database,
  limit: number,
): VaultIssue[] {
  const rows = db.prepare<[number], DeadLinkRow>(`
    SELECT source_path, target_raw, line_number
    FROM vault_links
    WHERE target_path IS NULL
    ORDER BY source_path
    LIMIT ?
  `).all(limit);

  return rows.map((r) => ({
    kind: "dead-link" as IssueKind,
    notePath: r.source_path,
    description: `Dead link [[${r.target_raw}]] on line ${r.line_number}`,
    autoFixable: false,
  }));
}

// ---------------------------------------------------------------------------
// Detection: orphan notes
// ---------------------------------------------------------------------------

interface OrphanRow {
  vault_path: string;
}

function detectOrphans(
  db: Database,
  limit: number,
): VaultIssue[] {
  const rows = db.prepare<[number], OrphanRow>(`
    SELECT vault_path
    FROM vault_health
    WHERE is_orphan = 1
    ORDER BY vault_path
    LIMIT ?
  `).all(limit);

  return rows
    .filter((r) => !isOrphanExempt(r.vault_path))
    .map((r) => ({
      kind: "orphan" as IssueKind,
      notePath: r.vault_path,
      description: "Note has no inbound or outbound links",
      autoFixable: false,
    }));
}

// ---------------------------------------------------------------------------
// Detection: missing parent links
// ---------------------------------------------------------------------------

interface VaultFileRow {
  vault_path: string;
}

interface LinkExistsRow {
  cnt: number;
}

function detectMissingParentLinks(
  db: Database,
  vaultRoot: string,
  limit: number,
): VaultIssue[] {
  const allFiles = db.prepare<[], VaultFileRow>(`
    SELECT vault_path FROM vault_files ORDER BY vault_path
  `).all();

  const checkLink = db.prepare<[string, string], LinkExistsRow>(`
    SELECT COUNT(*) AS cnt
    FROM vault_links
    WHERE source_path = ?
      AND target_path = ?
  `);

  // Pre-build a set of known vault paths for fast parent-note existence check
  const knownPaths = new Set(allFiles.map((r) => r.vault_path));

  const issues: VaultIssue[] = [];

  for (const row of allFiles) {
    if (issues.length >= limit) break;
    if (!isFolderNote(row.vault_path)) continue;

    const parentNotePath = deriveParentFolderNotePath(row.vault_path);
    if (!parentNotePath) continue;
    if (!knownPaths.has(parentNotePath)) continue;

    // Check if this file already has a link to the parent note
    const { cnt } = checkLink.get(row.vault_path, parentNotePath)!;
    if (cnt > 0) continue;

    // Build the wikilink text Obsidian would use for the parent:
    // strip .md extension and use vault-relative path without leading slash
    const wikilinkTarget = parentNotePath.replace(/\.md$/, "");

    issues.push({
      kind: "missing-parent-link",
      notePath: row.vault_path,
      description: `Folder note missing parent link to [[${wikilinkTarget}]]`,
      autoFixable: true,
      suggestedEdit: {
        targetPath: join(vaultRoot, row.vault_path),
        operation: "add-frontmatter-link",
        frontmatterKey: "links",
        wikilinkText: `[[${wikilinkTarget}]]`,
      },
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: dual-path conflicts
// ---------------------------------------------------------------------------

interface AliasRow {
  alias_path: string;
  canonical_path: string;
}

interface ConflictRow {
  source_path: string;
  target_raw: string;
}

function detectDualPathConflicts(
  db: Database,
  vaultRoot: string,
  limit: number,
): VaultIssue[] {
  // Build a map of alias → canonical for fast lookup
  const aliases = db.prepare<[], AliasRow>(`
    SELECT vault_path AS alias_path, canonical_path
    FROM vault_aliases
  `).all();

  if (aliases.length === 0) return [];

  const aliasSet = new Set(aliases.map((a) => a.alias_path));
  const aliasMap = new Map(aliases.map((a) => [a.alias_path, a.canonical_path]));

  // Find links that resolve to an alias path
  const conflictRows = db.prepare<[number], ConflictRow>(`
    SELECT source_path, target_raw
    FROM vault_links
    WHERE target_path IN (SELECT vault_path FROM vault_aliases)
    LIMIT ?
  `).all(limit);

  const issues: VaultIssue[] = [];

  for (const row of conflictRows) {
    // We need to find which alias this link resolved to.
    // The target_path for this link should be in our alias set.
    // Look it up via a join-style check.
    const resolvedTarget = db.prepare<[string, string], { target_path: string }>(`
      SELECT target_path FROM vault_links
      WHERE source_path = ? AND target_raw = ?
      LIMIT 1
    `).get(row.source_path, row.target_raw);

    if (!resolvedTarget?.target_path) continue;
    if (!aliasSet.has(resolvedTarget.target_path)) continue;

    const canonicalPath = aliasMap.get(resolvedTarget.target_path);
    if (!canonicalPath) continue;

    const oldWikilink = `[[${row.target_raw}]]`;
    const newTarget = canonicalPath.replace(/\.md$/, "");
    const newWikilink = `[[${newTarget}]]`;

    if (oldWikilink === newWikilink) continue;

    issues.push({
      kind: "dual-path-conflict",
      notePath: row.source_path,
      description: `Wikilink uses alias path "${row.target_raw}" instead of canonical "${newTarget}"`,
      autoFixable: true,
      suggestedEdit: {
        targetPath: join(vaultRoot, row.source_path),
        operation: "replace-wikilink",
        oldText: oldWikilink,
        newText: newWikilink,
      },
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Apply edits
// ---------------------------------------------------------------------------

/**
 * Apply a single SuggestedEdit to disk.
 * Returns true if the file was actually modified.
 */
function applyEdit(edit: SuggestedEdit): boolean {
  if (isArchived(edit.targetPath)) return false;

  if (edit.operation === "add-frontmatter-link") {
    if (!edit.frontmatterKey || !edit.wikilinkText) return false;
    return addFrontmatterLink(edit.targetPath, edit.frontmatterKey, edit.wikilinkText);
  }

  if (edit.operation === "replace-wikilink") {
    if (!edit.oldText || !edit.newText) return false;
    return replaceFrontmatterText(edit.targetPath, edit.oldText, edit.newText);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Count helpers for summary
// ---------------------------------------------------------------------------

interface CountRow {
  cnt: number;
}

function countNotes(db: Database): number {
  const row = db.prepare<[], CountRow>("SELECT COUNT(*) AS cnt FROM vault_files").get();
  return row?.cnt ?? 0;
}

function countLinks(db: Database): number {
  const row = db.prepare<[], CountRow>("SELECT COUNT(*) AS cnt FROM vault_links").get();
  return row?.cnt ?? 0;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the vault fixer: detect issues in the vault link graph and optionally
 * apply safe, non-destructive fixes.
 *
 * @param db        - better-sqlite3 Database handle (federation.db with vault tables)
 * @param vaultRoot - Absolute path to the Obsidian vault root directory
 * @param opts      - Detection and application options
 */
export async function runVaultFixer(
  db: Database,
  vaultRoot: string,
  opts: FixerOptions = {},
): Promise<VaultFixerReport> {
  const {
    apply = false,
    kinds,
    maxIssues = 200,
  } = opts;

  const shouldDetect = (kind: IssueKind): boolean =>
    !kinds || kinds.includes(kind);

  const errors: string[] = [];
  const issues: VaultIssue[] = [];

  // --- Dead links -----------------------------------------------------------
  if (shouldDetect("dead-link")) {
    try {
      const found = detectDeadLinks(db, maxIssues);
      issues.push(...found);
    } catch (err) {
      errors.push(`dead-link detection failed: ${String(err)}`);
    }
  }

  // --- Orphans --------------------------------------------------------------
  if (shouldDetect("orphan")) {
    try {
      const found = detectOrphans(db, maxIssues);
      issues.push(...found);
    } catch (err) {
      errors.push(`orphan detection failed: ${String(err)}`);
    }
  }

  // --- Missing parent links -------------------------------------------------
  if (shouldDetect("missing-parent-link")) {
    try {
      const found = detectMissingParentLinks(db, vaultRoot, maxIssues);
      issues.push(...found);
    } catch (err) {
      errors.push(`missing-parent-link detection failed: ${String(err)}`);
    }
  }

  // --- Dual-path conflicts --------------------------------------------------
  if (shouldDetect("dual-path-conflict")) {
    try {
      const found = detectDualPathConflicts(db, vaultRoot, maxIssues);
      issues.push(...found);
    } catch (err) {
      errors.push(`dual-path-conflict detection failed: ${String(err)}`);
    }
  }

  // --- Apply edits (opt-in) ------------------------------------------------
  let appliedEdits = 0;
  if (apply) {
    for (const issue of issues) {
      if (!issue.autoFixable || !issue.suggestedEdit) continue;
      try {
        const changed = applyEdit(issue.suggestedEdit);
        if (changed) appliedEdits++;
      } catch (err) {
        errors.push(
          `Failed to apply edit for ${issue.notePath}: ${String(err)}`,
        );
      }
    }
  }

  // --- Build summary counts ------------------------------------------------
  const byKind = (k: IssueKind) => issues.filter((i) => i.kind === k).length;

  const totalNotes = countNotes(db);
  const totalLinks = countLinks(db);

  const report: VaultFixerReport = {
    timestamp: new Date().toISOString(),
    vaultPath: vaultRoot,
    summary: {
      totalNotes,
      totalLinks,
      deadLinks: byKind("dead-link"),
      orphans: byKind("orphan"),
      missingParentLinks: byKind("missing-parent-link"),
      dualPathConflicts: byKind("dual-path-conflict"),
      fixableIssues: issues.filter((i) => i.autoFixable).length,
      appliedEdits,
    },
    issues,
    errors,
  };

  return report;
}
