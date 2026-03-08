/**
 * Main vault indexing orchestrator.
 *
 * Indexes an entire Obsidian vault (or any markdown knowledge base), following
 * symlinks, deduplicating files by inode, parsing wikilinks, and computing
 * per-file health metrics (orphan detection, dead links).
 *
 * Key differences from the project indexer (indexer/sync.ts):
 *  - Follows symbolic links (project indexer skips them)
 *  - Deduplicates files with the same inode (same content reachable via multiple paths)
 *  - Parses [[wikilinks]] and builds a directed link graph
 *  - Resolves wikilinks using Obsidian's shortest-match algorithm
 *  - Computes health metrics per file: inbound/outbound link counts, dead links, orphans
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type {
  StorageBackend,
  VaultFileRow,
  VaultAliasRow,
  VaultLinkRow,
  VaultHealthRow,
  VaultNameEntry,
  ChunkRow,
} from "../../storage/interface.js";
import { chunkMarkdown } from "../chunker.js";
import { sha256File, chunkId, yieldToEventLoop } from "../indexer/helpers.js";
import { walkVaultMdFiles } from "./walk.js";
import { deduplicateByInode } from "./deduplicate.js";
import { parseLinks } from "./parse-links.js";
import { buildNameIndex } from "./name-index.js";
import { resolveWikilink } from "./resolve.js";
import type { VaultIndexResult } from "./types.js";

/** Number of files to process before yielding to the event loop. */
const VAULT_YIELD_EVERY = 1;

/**
 * Index an entire Obsidian vault (or markdown knowledge base) using the
 * async StorageBackend interface.
 *
 * Steps:
 *  1. Walk vault root, following symlinks.
 *  2. Deduplicate by inode — each unique file is indexed once.
 *  3. Build a name index for wikilink resolution.
 *  4. For each canonical file:
 *     a. SHA-256 hash for change detection — skip unchanged files.
 *     b. Read content, chunk with chunkMarkdown().
 *     c. Insert chunks into backend (memory_chunks and memory_fts).
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
 * @param backend         StorageBackend to write to.
 * @param vaultProjectId  Registry project ID for the vault "project".
 * @param vaultRoot       Absolute path to the vault root directory.
 */
export async function indexVault(
  backend: StorageBackend,
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

  // Step 1: Walk vault, collecting all .md files (follows symlinks)
  const allFiles = walkVaultMdFiles(vaultRoot);

  // Step 2: Deduplicate by inode
  const inodeGroups = deduplicateByInode(allFiles);

  // Step 3: Build name index (from all files including aliases, for resolution)
  const nameIndex = buildNameIndex(allFiles);

  // Step 4: Index each canonical file
  await yieldToEventLoop();
  let filesSinceYield = 0;

  for (const group of inodeGroups) {
    if (filesSinceYield >= VAULT_YIELD_EVERY) {
      await yieldToEventLoop();
      filesSinceYield = 0;
    }
    filesSinceYield++;

    const { canonical } = group;

    let content: string;
    try {
      content = readFileSync(canonical.absPath, "utf8");
    } catch {
      result.filesSkipped++;
      continue;
    }

    const hash = sha256File(content);

    // Change detection: skip if hash is unchanged
    const existing = await backend.getVaultFile(canonical.vaultRelPath);
    if (existing?.hash === hash) {
      result.filesSkipped++;
      continue;
    }

    // Delete old chunks for this vault path
    await backend.deleteChunksForFile(vaultProjectId, canonical.vaultRelPath);

    // Chunk the content
    const chunks = chunkMarkdown(content);
    const updatedAt = Date.now();

    // Extract title from first H1 heading or filename
    const titleMatch = /^#\s+(.+)$/m.exec(content);
    const title = titleMatch
      ? titleMatch[1]!.trim()
      : basename(canonical.vaultRelPath, ".md");

    // Build chunk rows
    const chunkRows: ChunkRow[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const id = chunkId(
        vaultProjectId,
        canonical.vaultRelPath,
        i,
        chunk.startLine,
        chunk.endLine,
      );
      chunkRows.push({
        id,
        projectId: vaultProjectId,
        source: "vault",
        tier: "topic",
        path: canonical.vaultRelPath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        hash: chunk.hash,
        text: chunk.text,
        updatedAt,
      });
    }

    if (chunkRows.length > 0) {
      await backend.insertChunks(chunkRows);
    }

    // Upsert vault file record
    const vaultFileRow: VaultFileRow = {
      vaultPath: canonical.vaultRelPath,
      inode: canonical.inode,
      device: canonical.device,
      hash,
      title,
      indexedAt: updatedAt,
    };
    await backend.upsertVaultFile(vaultFileRow);

    result.filesIndexed++;
    result.chunksCreated += chunks.length;
  }

  // Step 5: Record aliases in vault_aliases
  await yieldToEventLoop();

  const allAliases: VaultAliasRow[] = [];
  for (const group of inodeGroups) {
    for (const alias of group.aliases) {
      allAliases.push({
        vaultPath: alias.vaultRelPath,
        canonicalPath: group.canonical.vaultRelPath,
        inode: alias.inode,
        device: alias.device,
      });
      result.aliasesRecorded++;
    }
  }

  const canonicalPaths = new Set(inodeGroups.map((g) => g.canonical.vaultRelPath));
  for (const canonPath of canonicalPaths) {
    await backend.deleteVaultAliases(canonPath);
  }
  if (allAliases.length > 0) {
    await backend.upsertVaultAliases(allAliases);
  }

  // Step 6: Rebuild vault_name_index
  await yieldToEventLoop();

  const nameEntries: VaultNameEntry[] = [];
  for (const [name, paths] of nameIndex) {
    for (const path of paths) {
      nameEntries.push({ name, vaultPath: path });
    }
  }
  await backend.replaceNameIndex(nameEntries);

  // Step 7: Rebuild vault_links
  await yieldToEventLoop();

  const linkRows: VaultLinkRow[] = [];
  const allSourcePaths: string[] = [];

  let linkParseYield = 0;
  for (const group of inodeGroups) {
    if (linkParseYield++ % VAULT_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }

    const { canonical } = group;
    allSourcePaths.push(canonical.vaultRelPath);

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
        sourcePath: canonical.vaultRelPath,
        targetRaw: link.raw,
        targetPath: target,
        linkType,
        lineNumber: link.lineNumber,
      });
    }
  }

  // Replace all links for all sources in batches of 500
  const LINK_BATCH_SIZE = 500;
  for (let i = 0; i < allSourcePaths.length; i += LINK_BATCH_SIZE) {
    const batchSources = allSourcePaths.slice(i, i + LINK_BATCH_SIZE);
    const batchLinks = linkRows.filter((r) => batchSources.includes(r.sourcePath));
    await backend.replaceLinksForSources(batchSources, batchLinks);
    await yieldToEventLoop();
  }

  result.linksExtracted = linkRows.length;
  result.deadLinksFound = linkRows.filter((r) => r.targetPath === null).length;

  // Step 8: Compute and upsert vault_health metrics
  await yieldToEventLoop();

  const outboundMap = new Map<string, number>();
  const deadMap = new Map<string, number>();
  const inboundMap = new Map<string, number>();

  for (const row of linkRows) {
    outboundMap.set(row.sourcePath, (outboundMap.get(row.sourcePath) ?? 0) + 1);
    if (row.targetPath === null) {
      deadMap.set(row.sourcePath, (deadMap.get(row.sourcePath) ?? 0) + 1);
    } else {
      inboundMap.set(row.targetPath, (inboundMap.get(row.targetPath) ?? 0) + 1);
    }
  }

  const computedAt = Date.now();
  let orphanCount = 0;

  const HEALTH_BATCH_SIZE = 500;
  for (let i = 0; i < inodeGroups.length; i += HEALTH_BATCH_SIZE) {
    const batch = inodeGroups.slice(i, i + HEALTH_BATCH_SIZE);
    const healthRows: VaultHealthRow[] = batch.map((group) => {
      const path = group.canonical.vaultRelPath;
      const inbound = inboundMap.get(path) ?? 0;
      const outbound = outboundMap.get(path) ?? 0;
      const dead = deadMap.get(path) ?? 0;
      const isOrphan = inbound === 0;
      if (isOrphan) orphanCount++;
      return {
        vaultPath: path,
        inboundCount: inbound,
        outboundCount: outbound,
        deadLinkCount: dead,
        isOrphan,
        computedAt,
      };
    });
    await backend.upsertVaultHealth(healthRows);
    await yieldToEventLoop();
  }

  result.orphansFound = orphanCount;
  result.elapsed = Date.now() - startTime;

  return result;
}
