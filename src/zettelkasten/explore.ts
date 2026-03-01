import type { Database } from "better-sqlite3";
import { dirname } from "node:path";

export interface ExploreOptions {
  startNote: string;
  depth?: number;
  direction?: "forward" | "backward" | "both";
  mode?: "sequential" | "associative" | "all";
}

export interface ExploreNode {
  path: string;
  title: string | null;
  depth: number;
  linkType: "sequential" | "associative";
  inbound: number;
  outbound: number;
}

export interface ExploreResult {
  root: string;
  nodes: ExploreNode[];
  edges: Array<{ from: string; to: string; type: "sequential" | "associative" }>;
  branchingPoints: string[];
  maxDepthReached: boolean;
}

function classifyEdge(source: string, target: string): "sequential" | "associative" {
  return dirname(source) === dirname(target) ? "sequential" : "associative";
}

function resolveStart(db: Database, startNote: string): string | null {
  const inFiles = db
    .prepare("SELECT vault_path FROM vault_files WHERE vault_path = ?")
    .get(startNote) as { vault_path: string } | undefined;
  if (inFiles) return inFiles.vault_path;

  const alias = db
    .prepare("SELECT canonical_path FROM vault_aliases WHERE vault_path = ?")
    .get(startNote) as { canonical_path: string } | undefined;
  if (!alias) return null;

  const canonical = db
    .prepare("SELECT vault_path FROM vault_files WHERE vault_path = ?")
    .get(alias.canonical_path) as { vault_path: string } | undefined;
  return canonical ? canonical.vault_path : null;
}

function getForwardNeighbors(db: Database, path: string): string[] {
  return (
    db
      .prepare(
        "SELECT target_path FROM vault_links WHERE source_path = ? AND target_path IS NOT NULL",
      )
      .all(path) as Array<{ target_path: string }>
  ).map((r) => r.target_path);
}

function getBackwardNeighbors(db: Database, path: string): string[] {
  return (
    db
      .prepare(
        "SELECT source_path FROM vault_links WHERE target_path = ?",
      )
      .all(path) as Array<{ source_path: string }>
  ).map((r) => r.source_path);
}

function getFileInfo(
  db: Database,
  path: string,
): { title: string | null; inbound: number; outbound: number } {
  const file = db
    .prepare("SELECT title FROM vault_files WHERE vault_path = ?")
    .get(path) as { title: string | null } | undefined;

  const health = db
    .prepare("SELECT inbound_count, outbound_count FROM vault_health WHERE vault_path = ?")
    .get(path) as { inbound_count: number; outbound_count: number } | undefined;

  return {
    title: file?.title ?? null,
    inbound: health?.inbound_count ?? 0,
    outbound: health?.outbound_count ?? 0,
  };
}

/**
 * Traverse the Zettelkasten link graph using BFS, following chains of thought
 * from a starting note up to a configurable depth.
 */
export function zettelExplore(db: Database, opts: ExploreOptions): ExploreResult {
  const depth = Math.min(Math.max(opts.depth ?? 3, 1), 10);
  const direction = opts.direction ?? "both";
  const mode = opts.mode ?? "all";

  const root = resolveStart(db, opts.startNote);
  if (!root) {
    return {
      root: opts.startNote,
      nodes: [],
      edges: [],
      branchingPoints: [],
      maxDepthReached: false,
    };
  }

  const visited = new Set<string>([root]);
  const nodes: ExploreNode[] = [];
  const edges: Array<{ from: string; to: string; type: "sequential" | "associative" }> = [];
  let maxDepthReached = false;

  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.depth >= depth) {
      maxDepthReached = true;
      continue;
    }

    const neighbors: Array<{ neighbor: string; from: string; to: string }> = [];

    if (direction === "forward" || direction === "both") {
      for (const n of getForwardNeighbors(db, current.path)) {
        neighbors.push({ neighbor: n, from: current.path, to: n });
      }
    }

    if (direction === "backward" || direction === "both") {
      for (const n of getBackwardNeighbors(db, current.path)) {
        neighbors.push({ neighbor: n, from: n, to: current.path });
      }
    }

    for (const { neighbor, from, to } of neighbors) {
      const edgeType = classifyEdge(from, to);

      if (mode !== "all" && edgeType !== mode) {
        continue;
      }

      const edgeKey = `${from}|${to}`;
      const alreadyHasEdge = edges.some((e) => e.from === from && e.to === to);
      if (!alreadyHasEdge) {
        edges.push({ from, to, type: edgeType });
      }

      if (!visited.has(neighbor)) {
        visited.add(neighbor);

        const info = getFileInfo(db, neighbor);
        nodes.push({
          path: neighbor,
          title: info.title,
          depth: current.depth + 1,
          linkType: edgeType,
          inbound: info.inbound,
          outbound: info.outbound,
        });

        queue.push({ path: neighbor, depth: current.depth + 1 });
      }
    }
  }

  const branchingPoints = nodes
    .filter((n) => n.outbound > 2)
    .map((n) => n.path);

  const rootInfo = getFileInfo(db, root);
  if (rootInfo.outbound > 2) {
    branchingPoints.unshift(root);
  }

  return { root, nodes, edges, branchingPoints, maxDepthReached };
}
