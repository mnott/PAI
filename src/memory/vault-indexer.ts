/**
 * Vault indexer for the PAI federation memory engine.
 *
 * Indexes an entire Obsidian vault (or any markdown knowledge base), following
 * symlinks, deduplicating files by inode, parsing wikilinks, and computing
 * per-file health metrics (orphan detection, dead links).
 *
 * Key differences from the project indexer (indexer.ts):
 *  - Follows symbolic links (project indexer skips them)
 *  - Deduplicates files with the same inode (same content reachable via multiple paths)
 *  - Parses [[wikilinks]] and builds a directed link graph
 *  - Resolves wikilinks using Obsidian's shortest-match algorithm
 *  - Computes health metrics per file: inbound/outbound link counts, dead links, orphans
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, relative, basename, dirname, normalize } from "node:path";
import type { Database } from "better-sqlite3";
import { chunkMarkdown } from "./chunker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultFile {
  absPath: string;
  vaultRelPath: string;
  inode: number;
  device: number;
}

export interface InodeGroup {
  canonical: VaultFile;
  aliases: VaultFile[];
}

export interface ParsedLink {
  raw: string;
  alias: string | null;
  lineNumber: number;
  isEmbed: boolean;
  /** True when parsed from markdown `[text](path)` syntax (vs `[[wikilink]]`). */
  isMdLink?: boolean;
}

export interface VaultIndexResult {
  filesIndexed: number;
  chunksCreated: number;
  filesSkipped: number;
  aliasesRecorded: number;
  linksExtracted: number;
  deadLinksFound: number;
  orphansFound: number;
  elapsed: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of .md files to collect from a vault. */
const VAULT_MAX_FILES = 10_000;

/** Maximum recursion depth for vault directory walks. */
const VAULT_MAX_DEPTH = 10;

/** Number of files to process before yielding to the event loop. */
const VAULT_YIELD_EVERY = 10;

/**
 * Directories to always skip, at any depth, during vault walks.
 * Includes standard build/VCS noise plus Obsidian-specific directories.
 */
const VAULT_SKIP_DIRS = new Set([
  // Version control
  ".git",
  // Dependency directories (any language)
  "node_modules",
  "vendor",
  "Pods",
  // Build / compile output
  "dist",
  "build",
  "out",
  "DerivedData",
  ".next",
  // Python virtual environments and caches
  ".venv",
  "venv",
  "__pycache__",
  // General caches
  ".cache",
  ".bun",
  // Obsidian internals
  ".obsidian",
  ".trash",
]);

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sha256File(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function chunkId(
  projectId: number,
  path: string,
  chunkIndex: number,
  startLine: number,
  endLine: number,
): string {
  return createHash("sha256")
    .update(`${projectId}:${path}:${chunkIndex}:${startLine}:${endLine}`)
    .digest("hex");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Vault directory walker (follows symlinks)
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .md files under a vault root, following symlinks.
 *
 * Symlink-following behaviour:
 *  - Symbolic links to files: followed if the target is a .md file
 *  - Symbolic links to directories: followed with cycle detection via inode
 *
 * Cycle detection is based on the real inode of each visited directory.
 * Using the real stat (not lstat) ensures that symlinked dirs resolve to
 * their actual inode, preventing infinite loops.
 *
 * @param dir        Directory to scan.
 * @param vaultRoot  Absolute root of the vault (for computing vaultRelPath).
 * @param acc        Shared accumulator (mutated in place for early exit).
 * @param visited    Set of "device:inode" strings for visited directories.
 * @param depth      Current recursion depth.
 */
export function walkVaultMdFiles(
  vaultRoot: string,
  opts?: { maxFiles?: number; maxDepth?: number },
): VaultFile[] {
  const maxFiles = opts?.maxFiles ?? VAULT_MAX_FILES;
  const maxDepth = opts?.maxDepth ?? VAULT_MAX_DEPTH;

  const results: VaultFile[] = [];
  const visitedDirs = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (results.length >= maxFiles) return;
    if (depth > maxDepth) return;

    // Get the real inode of this directory (follows symlinks on the dir itself)
    let dirStat: ReturnType<typeof statSync>;
    try {
      dirStat = statSync(dir);
    } catch {
      return; // Unreadable or broken symlink — skip
    }

    const dirKey = `${dirStat.dev}:${dirStat.ino}`;
    if (visitedDirs.has(dirKey)) return; // Cycle detected
    visitedDirs.add(dirKey);

    let entries: import("node:fs").Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return; // Unreadable directory — skip
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (VAULT_SKIP_DIRS.has(entry.name)) continue;

      const full = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        // Follow the symlink — resolve to real target
        let targetStat: ReturnType<typeof statSync>;
        try {
          targetStat = statSync(full); // statSync follows symlinks
        } catch {
          continue; // Broken symlink — skip
        }

        if (targetStat.isDirectory()) {
          if (!VAULT_SKIP_DIRS.has(entry.name)) {
            walk(full, depth + 1);
          }
        } else if (targetStat.isFile() && entry.name.endsWith(".md")) {
          results.push({
            absPath: full,
            vaultRelPath: relative(vaultRoot, full),
            inode: targetStat.ino,
            device: targetStat.dev,
          });
        }
      } else if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        let fileStat: ReturnType<typeof statSync>;
        try {
          fileStat = statSync(full);
        } catch {
          continue;
        }
        results.push({
          absPath: full,
          vaultRelPath: relative(vaultRoot, full),
          inode: fileStat.ino,
          device: fileStat.dev,
        });
      }
    }
  }

  if (existsSync(vaultRoot)) {
    walk(vaultRoot, 0);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Inode deduplication
// ---------------------------------------------------------------------------

/**
 * Group vault files by inode identity (device + inode).
 *
 * Within each group, the canonical file is chosen as the one with the
 * fewest path separators (shallowest), breaking ties by shortest string.
 * All other group members become aliases.
 */
export function deduplicateByInode(files: VaultFile[]): InodeGroup[] {
  const groups = new Map<string, VaultFile[]>();

  for (const file of files) {
    const key = `${file.device}:${file.inode}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(file);
    } else {
      groups.set(key, [file]);
    }
  }

  const result: InodeGroup[] = [];

  for (const group of groups.values()) {
    if (group.length === 0) continue;

    // Sort: fewest path separators first, then shortest string
    const sorted = [...group].sort((a, b) => {
      const aDepth = (a.vaultRelPath.match(/\//g) ?? []).length;
      const bDepth = (b.vaultRelPath.match(/\//g) ?? []).length;
      if (aDepth !== bDepth) return aDepth - bDepth;
      return a.vaultRelPath.length - b.vaultRelPath.length;
    });

    const [canonical, ...aliases] = sorted as [VaultFile, ...VaultFile[]];
    result.push({ canonical, aliases });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Link parser (wikilinks + markdown links)
// ---------------------------------------------------------------------------

/**
 * Parse all links from markdown content.
 *
 * Handles:
 *  - Standard wikilinks: [[Target Note]]
 *  - Aliased wikilinks: [[Target Note|Display Text]]
 *  - Heading anchors: [[Target Note#Heading]] (stripped for resolution)
 *  - Embeds: ![[Target Note]]
 *  - Frontmatter wikilinks (YAML between --- delimiters)
 *  - Markdown links: [text](path/to/note.md)
 *  - Markdown embeds: ![alt](image.png)
 *
 * External URLs (http://, https://, mailto:, etc.) are excluded — only
 * relative paths are treated as vault links.
 *
 * @param content  Raw markdown file content.
 * @returns        Array of parsed links in document order.
 */
export function parseLinks(content: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  const lines = content.split("\n");

  // Determine frontmatter range (YAML between opening and closing ---)
  let frontmatterEnd = 0;
  if (content.startsWith("---")) {
    const closingIdx = content.indexOf("\n---", 3);
    if (closingIdx !== -1) {
      frontmatterEnd = content.slice(0, closingIdx + 4).split("\n").length - 1;
    }
  }

  // Regex for [[wikilinks]] and ![[embeds]]
  const wikilinkRe = /(!?)\[\[([^\]]+?)\]\]/g;

  // Regex for markdown links [text](target) and embeds ![alt](target)
  // Negative lookbehind avoids matching wikilinks already captured above.
  // The target group excludes closing paren and whitespace-after-URL.
  const mdLinkRe = /(!)?\[([^\]]*)\]\(([^)]+)\)/g;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const lineNumber = lineIdx + 1; // 1-indexed
    const isFrontmatter = lineIdx < frontmatterEnd;

    // --- Wikilinks ---
    wikilinkRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = wikilinkRe.exec(line)) !== null) {
      const isEmbed = match[1] === "!";
      const inner = match[2]!;

      // Split on first | for alias
      const pipeIdx = inner.indexOf("|");
      const beforePipe = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
      const alias = pipeIdx === -1 ? null : inner.slice(pipeIdx + 1);

      // Strip heading anchor (everything after #)
      const hashIdx = beforePipe.indexOf("#");
      const raw = hashIdx === -1 ? beforePipe.trim() : beforePipe.slice(0, hashIdx).trim();

      if (!raw) continue; // Skip links with empty targets (e.g. [[#Heading]])

      links.push({
        raw,
        alias: alias?.trim() ?? null,
        lineNumber,
        isEmbed: isEmbed && !isFrontmatter,
        isMdLink: false,
      });
    }

    // --- Markdown links --- (skip inside frontmatter)
    if (!isFrontmatter) {
      mdLinkRe.lastIndex = 0;
      while ((match = mdLinkRe.exec(line)) !== null) {
        const isEmbed = match[1] === "!";
        const displayText = match[2]!;
        let target = match[3]!.trim();

        // Skip external URLs
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;

        // Skip pure anchor links (#heading)
        if (target.startsWith("#")) continue;

        // Strip heading anchor from target
        const hashIdx = target.indexOf("#");
        if (hashIdx !== -1) target = target.slice(0, hashIdx);

        // URL-decode (Obsidian encodes spaces as %20 in md links)
        try {
          target = decodeURIComponent(target);
        } catch {
          // Malformed encoding — use as-is
        }

        // Strip .md extension for resolution (resolveWikilink adds it back)
        const raw = target.replace(/\.md$/i, "").trim();
        if (!raw) continue;

        // Skip if this exact position was already captured as a wikilink
        // (e.g. [[link]] inside a markdown link won't happen, but be safe)
        links.push({
          raw,
          alias: displayText || null,
          lineNumber,
          isEmbed,
          isMdLink: true,
        });
      }
    }
  }

  return links;
}

/** @deprecated Use {@link parseLinks} instead. */
export const parseWikilinks = parseLinks;

// ---------------------------------------------------------------------------
// Name index builder
// ---------------------------------------------------------------------------

/**
 * Build a name lookup index for Obsidian wikilink resolution.
 *
 * Maps lowercase filename (without .md extension) to all vault-relative paths
 * that share that name. Includes both canonical paths and alias paths so that
 * wikilinks resolve regardless of which path the file is accessed through.
 */
export function buildNameIndex(files: VaultFile[]): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const file of files) {
    const name = basename(file.vaultRelPath, ".md").toLowerCase();
    const existing = index.get(name);
    if (existing) {
      existing.push(file.vaultRelPath);
    } else {
      index.set(name, [file.vaultRelPath]);
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Wikilink resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a wikilink target to a vault-relative path using Obsidian's rules.
 *
 * Resolution algorithm:
 *  1. If raw contains "/", attempt exact path match (with and without .md).
 *  2. Normalize: lowercase the raw target, strip .md extension.
 *  3. Look up in the name index (all files with that basename).
 *  4. If exactly one match, return it.
 *  5. If multiple matches, pick the one closest to the source file
 *     (longest common directory prefix, then shortest overall path).
 *  6. If no matches, return null (dead link).
 *
 * @param raw         The raw link target (heading-stripped, pipe-stripped).
 * @param nameIndex   Map from lowercase basename-without-ext to vault paths.
 * @param sourcePath  Vault-relative path of the file containing the link.
 * @returns           Vault-relative path of the resolved target, or null.
 */
export function resolveWikilink(
  raw: string,
  nameIndex: Map<string, string[]>,
  sourcePath: string,
): string | null {
  if (!raw) return null;

  // Case 1: path contains "/" — try exact match with and without .md
  if (raw.includes("/")) {
    const normalized = normalize(raw);
    const normalizedMd = normalized.endsWith(".md") ? normalized : normalized + ".md";

    // Check if any indexed path matches (case-insensitive for macOS compatibility)
    for (const [, paths] of nameIndex) {
      for (const p of paths) {
        if (p === normalizedMd || p === normalized) return p;
        if (p.toLowerCase() === normalizedMd.toLowerCase()) return p;
      }
    }
    // Fall through to name lookup in case the path prefix was wrong
  }

  // Normalize the raw target for name lookup.
  // Use the basename only — Obsidian resolves by filename, not full path.
  // E.g. "PAI/20-webseiten/_20-webseiten-master" → "_20-webseiten-master"
  const rawBase = basename(raw)
    .replace(/\.md$/i, "")
    .toLowerCase()
    .trim();

  if (!rawBase) return null;

  const candidates = nameIndex.get(rawBase);

  if (!candidates || candidates.length === 0) {
    return null; // Dead link
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  // Multiple matches — pick the one closest to the source file
  const sourceDir = dirname(sourcePath);

  let bestPath: string | null = null;
  let bestPrefixLen = -1;
  let bestPathLen = Infinity;

  for (const candidate of candidates) {
    const candidateDir = dirname(candidate);
    const prefixLen = commonPrefixLength(sourceDir, candidateDir);
    const pathLen = candidate.length;

    if (
      prefixLen > bestPrefixLen ||
      (prefixLen === bestPrefixLen && pathLen < bestPathLen)
    ) {
      bestPrefixLen = prefixLen;
      bestPathLen = pathLen;
      bestPath = candidate;
    }
  }

  return bestPath;
}

/**
 * Compute the length of the common prefix between two directory paths,
 * measured in path segments (not raw characters).
 *
 * Example: "a/b/c" and "a/b/d" → 2 (common: "a", "b")
 */
function commonPrefixLength(a: string, b: string): number {
  if (a === "." && b === ".") return 0;
  const aParts = a === "." ? [] : a.split("/");
  const bParts = b === "." ? [] : b.split("/");
  let count = 0;
  const len = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    if (aParts[i] === bParts[i]) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main vault indexing orchestrator
// ---------------------------------------------------------------------------

/**
 * Index an entire Obsidian vault (or markdown knowledge base) into the
 * federation database.
 *
 * Steps:
 *  1. Walk vault root, following symlinks.
 *  2. Deduplicate by inode — each unique file is indexed once.
 *  3. Build a name index for wikilink resolution.
 *  4. For each canonical file:
 *     a. SHA-256 hash for change detection — skip unchanged files.
 *     b. Read content, chunk with chunkMarkdown().
 *     c. Insert chunks into memory_chunks and memory_fts.
 *     d. Upsert vault_files row.
 *  5. Record aliases in vault_aliases.
 *  6. Rebuild vault_name_index table.
 *  7. Rebuild vault_links:
 *     a. Parse [[wikilinks]] from each canonical file.
 *     b. Resolve each link with resolveWikilink().
 *     c. Insert into vault_links.
 *  8. Compute and upsert health metrics (vault_health).
 *  9. Return statistics.
 *
 * @param db              Open federation database.
 * @param vaultProjectId  Registry project ID for the vault "project".
 * @param vaultRoot       Absolute path to the vault root directory.
 */
export async function indexVault(
  db: Database,
  vaultProjectId: number,
  vaultRoot: string,
): Promise<VaultIndexResult> {
  const startTime = Date.now();

  const result: VaultIndexResult = {
    filesIndexed: 0,
    chunksCreated: 0,
    filesSkipped: 0,
    aliasesRecorded: 0,
    linksExtracted: 0,
    deadLinksFound: 0,
    orphansFound: 0,
    elapsed: 0,
  };

  // ---------------------------------------------------------------------------
  // Step 1: Walk vault, collecting all .md files (follows symlinks)
  // ---------------------------------------------------------------------------

  const allFiles = walkVaultMdFiles(vaultRoot);

  // ---------------------------------------------------------------------------
  // Step 2: Deduplicate by inode
  // ---------------------------------------------------------------------------

  const inodeGroups = deduplicateByInode(allFiles);

  // ---------------------------------------------------------------------------
  // Step 3: Build name index (from all files including aliases, for resolution)
  // ---------------------------------------------------------------------------

  const nameIndex = buildNameIndex(allFiles);

  // ---------------------------------------------------------------------------
  // Step 4: Prepare SQL statements
  // ---------------------------------------------------------------------------

  const selectFileHash = db.prepare(
    "SELECT hash FROM vault_files WHERE vault_path = ?",
  );

  const deleteOldChunkIds = db.prepare(
    "SELECT id FROM memory_chunks WHERE project_id = ? AND path = ?",
  );

  const deleteFts = db.prepare("DELETE FROM memory_fts WHERE id = ?");

  const deleteChunks = db.prepare(
    "DELETE FROM memory_chunks WHERE project_id = ? AND path = ?",
  );

  const insertChunk = db.prepare(`
    INSERT INTO memory_chunks (id, project_id, source, tier, path, start_line, end_line, hash, text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO memory_fts (text, id, project_id, path, source, tier, start_line, end_line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertVaultFile = db.prepare(`
    INSERT INTO vault_files (vault_path, inode, device, hash, title, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(vault_path) DO UPDATE SET
      inode      = excluded.inode,
      device     = excluded.device,
      hash       = excluded.hash,
      title      = excluded.title,
      indexed_at = excluded.indexed_at
  `);

  // ---------------------------------------------------------------------------
  // Step 4 (cont.): Index each canonical file
  // ---------------------------------------------------------------------------

  await yieldToEventLoop();
  let filesSinceYield = 0;

  for (const group of inodeGroups) {
    // Yield periodically to keep the IPC server responsive
    if (filesSinceYield >= VAULT_YIELD_EVERY) {
      await yieldToEventLoop();
      filesSinceYield = 0;
    }
    filesSinceYield++;

    const { canonical } = group;

    // Read file content
    let content: string;
    try {
      content = readFileSync(canonical.absPath, "utf8");
    } catch {
      result.filesSkipped++;
      continue;
    }

    const hash = sha256File(content);

    // Change detection: skip if hash is unchanged
    const existing = selectFileHash.get(canonical.vaultRelPath) as
      | { hash: string }
      | undefined;

    if (existing?.hash === hash) {
      result.filesSkipped++;
      continue;
    }

    // Delete old chunks for this vault path
    const oldChunkIds = deleteOldChunkIds.all(
      vaultProjectId,
      canonical.vaultRelPath,
    ) as Array<{ id: string }>;

    db.transaction(() => {
      for (const row of oldChunkIds) {
        deleteFts.run(row.id);
      }
      deleteChunks.run(vaultProjectId, canonical.vaultRelPath);
    })();

    // Chunk the content
    const chunks = chunkMarkdown(content);
    const updatedAt = Date.now();

    // Extract title from first H1 heading or filename
    const titleMatch = /^#\s+(.+)$/m.exec(content);
    const title = titleMatch
      ? titleMatch[1]!.trim()
      : basename(canonical.vaultRelPath, ".md");

    db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const id = chunkId(
          vaultProjectId,
          canonical.vaultRelPath,
          i,
          chunk.startLine,
          chunk.endLine,
        );
        insertChunk.run(
          id,
          vaultProjectId,
          "vault",
          "topic",
          canonical.vaultRelPath,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          chunk.text,
          updatedAt,
        );
        insertFts.run(
          chunk.text,
          id,
          vaultProjectId,
          canonical.vaultRelPath,
          "vault",
          "topic",
          chunk.startLine,
          chunk.endLine,
        );
      }
      upsertVaultFile.run(
        canonical.vaultRelPath,
        canonical.inode,
        canonical.device,
        hash,
        title,
        updatedAt,
      );
    })();

    result.filesIndexed++;
    result.chunksCreated += chunks.length;
  }

  // ---------------------------------------------------------------------------
  // Step 5: Record aliases in vault_aliases
  // ---------------------------------------------------------------------------

  await yieldToEventLoop();

  // Clear old aliases for this vault before rebuilding
  // (We identify vault aliases by checking which canonical paths belong to
  //  the canonical files we just indexed — simpler to clear + rebuild all.)
  db.exec("DELETE FROM vault_aliases");

  const insertAlias = db.prepare(`
    INSERT OR REPLACE INTO vault_aliases (vault_path, canonical_path, inode, device)
    VALUES (?, ?, ?, ?)
  `);

  const insertAliasesTx = db.transaction((groups: InodeGroup[]) => {
    for (const group of groups) {
      for (const alias of group.aliases) {
        insertAlias.run(
          alias.vaultRelPath,
          group.canonical.vaultRelPath,
          alias.inode,
          alias.device,
        );
        result.aliasesRecorded++;
      }
    }
  });
  insertAliasesTx(inodeGroups);

  // ---------------------------------------------------------------------------
  // Step 6: Rebuild vault_name_index
  // ---------------------------------------------------------------------------

  await yieldToEventLoop();

  db.exec("DELETE FROM vault_name_index");

  const insertNameIndex = db.prepare(`
    INSERT OR REPLACE INTO vault_name_index (name, vault_path) VALUES (?, ?)
  `);

  const insertNameIndexTx = db.transaction(
    (entries: Array<[string, string]>) => {
      for (const [name, path] of entries) {
        insertNameIndex.run(name, path);
      }
    },
  );

  const nameEntries: Array<[string, string]> = [];
  for (const [name, paths] of nameIndex) {
    for (const path of paths) {
      nameEntries.push([name, path]);
    }
  }
  insertNameIndexTx(nameEntries);

  // ---------------------------------------------------------------------------
  // Step 7: Rebuild vault_links
  // ---------------------------------------------------------------------------

  await yieldToEventLoop();

  db.exec("DELETE FROM vault_links");

  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO vault_links
      (source_path, target_raw, target_path, link_type, line_number)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Parse and resolve wikilinks in bulk transaction
  const linkRows: Array<{
    source: string;
    raw: string;
    target: string | null;
    linkType: string;
    lineNumber: number;
  }> = [];

  for (const group of inodeGroups) {
    const { canonical } = group;

    let content: string;
    try {
      content = readFileSync(canonical.absPath, "utf8");
    } catch {
      continue;
    }

    const parsedLinks = parseLinks(content);
    for (const link of parsedLinks) {
      const target = resolveWikilink(link.raw, nameIndex, canonical.vaultRelPath);
      let linkType: string;
      if (link.isMdLink) {
        linkType = link.isEmbed ? "md-embed" : "md-link";
      } else {
        linkType = link.isEmbed ? "embed" : "wikilink";
      }
      linkRows.push({
        source: canonical.vaultRelPath,
        raw: link.raw,
        target,
        linkType,
        lineNumber: link.lineNumber,
      });
    }
  }

  const insertLinksTx = db.transaction(
    (
      rows: Array<{
        source: string;
        raw: string;
        target: string | null;
        linkType: string;
        lineNumber: number;
      }>,
    ) => {
      for (const row of rows) {
        insertLink.run(row.source, row.raw, row.target, row.linkType, row.lineNumber);
      }
    },
  );
  insertLinksTx(linkRows);

  result.linksExtracted = linkRows.length;
  result.deadLinksFound = linkRows.filter((r) => r.target === null).length;

  // ---------------------------------------------------------------------------
  // Step 8: Compute and upsert vault_health metrics
  // ---------------------------------------------------------------------------

  await yieldToEventLoop();

  // Count outbound links per source
  const outboundCounts = db
    .prepare(
      `SELECT source_path, COUNT(*) AS cnt FROM vault_links GROUP BY source_path`,
    )
    .all() as Array<{ source_path: string; cnt: number }>;

  // Count dead links per source
  const deadLinkCounts = db
    .prepare(
      `SELECT source_path, COUNT(*) AS cnt FROM vault_links
       WHERE target_path IS NULL GROUP BY source_path`,
    )
    .all() as Array<{ source_path: string; cnt: number }>;

  // Count inbound links per target
  const inboundCounts = db
    .prepare(
      `SELECT target_path, COUNT(*) AS cnt FROM vault_links
       WHERE target_path IS NOT NULL GROUP BY target_path`,
    )
    .all() as Array<{ target_path: string; cnt: number }>;

  // Build maps for O(1) lookup
  const outboundMap = new Map<string, number>(
    outboundCounts.map((r) => [r.source_path, r.cnt]),
  );
  const deadMap = new Map<string, number>(
    deadLinkCounts.map((r) => [r.source_path, r.cnt]),
  );
  const inboundMap = new Map<string, number>(
    inboundCounts.map((r) => [r.target_path, r.cnt]),
  );

  const upsertHealth = db.prepare(`
    INSERT INTO vault_health
      (vault_path, inbound_count, outbound_count, dead_link_count, is_orphan, computed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(vault_path) DO UPDATE SET
      inbound_count   = excluded.inbound_count,
      outbound_count  = excluded.outbound_count,
      dead_link_count = excluded.dead_link_count,
      is_orphan       = excluded.is_orphan,
      computed_at     = excluded.computed_at
  `);

  const computedAt = Date.now();
  let orphanCount = 0;

  const upsertHealthTx = db.transaction((groups: InodeGroup[]) => {
    for (const group of groups) {
      const path = group.canonical.vaultRelPath;
      const inbound = inboundMap.get(path) ?? 0;
      const outbound = outboundMap.get(path) ?? 0;
      const dead = deadMap.get(path) ?? 0;
      const isOrphan = inbound === 0 ? 1 : 0;
      if (isOrphan) orphanCount++;
      upsertHealth.run(path, inbound, outbound, dead, isOrphan, computedAt);
    }
  });
  upsertHealthTx(inodeGroups);

  result.orphansFound = orphanCount;
  result.elapsed = Date.now() - startTime;

  return result;
}
