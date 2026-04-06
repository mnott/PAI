/**
 * God-note detection — find hub notes via degree centrality on the vault link graph.
 *
 * Hub notes (or "god notes") are notes with unusually high inbound link counts.
 * They represent core concepts that the rest of the vault frequently references.
 * Structural pages (index, MOC, master notes, tag pages) are filtered out.
 */

import type { StorageBackend } from "../storage/interface.js";

export interface GodNoteOptions {
  /** Maximum number of hub notes to return. Default: 20. */
  limit?: number;
  /** Minimum inbound link count to qualify as a hub. Default: 3. */
  minInbound?: number;
  /** Include outbound counts in the result. Default: true. */
  includeOutbound?: boolean;
}

export interface GodNote {
  path: string;
  title: string | null;
  inboundCount: number;
  outboundCount: number;
  /** Ratio of inbound to total degree — higher means more "sink"-like. */
  inboundRatio: number;
}

export interface GodNoteResult {
  godNotes: GodNote[];
  totalVaultFiles: number;
  /** Median inbound count across all vault files (for context). */
  medianInbound: number;
}

/** Patterns that identify structural/meta pages rather than concept notes. */
const STRUCTURAL_PATTERNS = [
  /\bindex\b/i,
  /\bMOC\b/,
  /\bmaster\b/i,
  /\btag\s*page/i,
  /\bhome\b/i,
  /\bdashboard\b/i,
  /\btemplate/i,
  /^_/,
];

function isStructuralNote(title: string | null, path: string): boolean {
  const text = title ?? path;
  return STRUCTURAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Find hub/"god" notes in the vault — notes with the highest inbound link counts,
 * excluding structural pages.
 */
export async function zettelGodNotes(
  backend: StorageBackend,
  opts?: GodNoteOptions,
): Promise<GodNoteResult> {
  const limit = opts?.limit ?? 20;
  const minInbound = opts?.minInbound ?? 3;

  // Get the full link graph
  const linkGraph = await backend.getVaultLinkGraph();

  // Count inbound and outbound per path
  const inboundCounts = new Map<string, number>();
  const outboundCounts = new Map<string, number>();

  for (const { source_path, target_path } of linkGraph) {
    inboundCounts.set(target_path, (inboundCounts.get(target_path) ?? 0) + 1);
    outboundCounts.set(source_path, (outboundCounts.get(source_path) ?? 0) + 1);
  }

  // Get all vault files for title lookup and total count
  const allFiles = await backend.getAllVaultFiles();
  const titleMap = new Map<string, string | null>();
  for (const f of allFiles) {
    titleMap.set(f.vaultPath, f.title);
  }

  const totalVaultFiles = allFiles.length;

  // Compute median inbound for context
  const allInbounds = allFiles.map((f) => inboundCounts.get(f.vaultPath) ?? 0);
  allInbounds.sort((a, b) => a - b);
  const medianInbound =
    allInbounds.length > 0
      ? allInbounds[Math.floor(allInbounds.length / 2)]
      : 0;

  // Build candidate list: all paths with inbound >= minInbound, excluding structural
  const candidates: GodNote[] = [];

  for (const [path, inbound] of inboundCounts) {
    if (inbound < minInbound) continue;

    const title = titleMap.get(path) ?? null;
    if (isStructuralNote(title, path)) continue;

    const outbound = outboundCounts.get(path) ?? 0;
    const totalDegree = inbound + outbound;
    const inboundRatio = totalDegree > 0 ? inbound / totalDegree : 0;

    candidates.push({
      path,
      title,
      inboundCount: inbound,
      outboundCount: outbound,
      inboundRatio: Math.round(inboundRatio * 1000) / 1000,
    });
  }

  // Sort by inbound count descending
  candidates.sort((a, b) => b.inboundCount - a.inboundCount);

  return {
    godNotes: candidates.slice(0, limit),
    totalVaultFiles,
    medianInbound,
  };
}
