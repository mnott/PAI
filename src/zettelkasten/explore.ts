import type { StorageBackend } from "../storage/interface.js";
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

async function resolveStart(backend: StorageBackend, startNote: string): Promise<string | null> {
  // Try direct lookup first
  const files = await backend.getVaultFilesByPaths([startNote]);
  if (files.length > 0) return files[0].vaultPath;

  // Try alias lookup
  const alias = await backend.getVaultAlias(startNote);
  if (!alias) return null;

  const canonical = await backend.getVaultFilesByPaths([alias.canonicalPath]);
  return canonical.length > 0 ? canonical[0].vaultPath : null;
}

async function getForwardNeighbors(backend: StorageBackend, path: string): Promise<string[]> {
  const links = await backend.getLinksFromSource(path);
  return links.filter(l => l.targetPath !== null).map(l => l.targetPath as string);
}

async function getBackwardNeighbors(backend: StorageBackend, path: string): Promise<string[]> {
  const links = await backend.getLinksToTarget(path);
  return links.map(l => l.sourcePath);
}

async function getFileInfo(
  backend: StorageBackend,
  path: string,
): Promise<{ title: string | null; inbound: number; outbound: number }> {
  const [files, health] = await Promise.all([
    backend.getVaultFilesByPaths([path]),
    backend.getVaultHealth(path),
  ]);

  return {
    title: files[0]?.title ?? null,
    inbound: health?.inboundCount ?? 0,
    outbound: health?.outboundCount ?? 0,
  };
}

/**
 * Traverse the Zettelkasten link graph using BFS, following chains of thought
 * from a starting note up to a configurable depth.
 */
export async function zettelExplore(backend: StorageBackend, opts: ExploreOptions): Promise<ExploreResult> {
  const depth = Math.min(Math.max(opts.depth ?? 3, 1), 10);
  const direction = opts.direction ?? "both";
  const mode = opts.mode ?? "all";

  const root = await resolveStart(backend, opts.startNote);
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
      for (const n of await getForwardNeighbors(backend, current.path)) {
        neighbors.push({ neighbor: n, from: current.path, to: n });
      }
    }

    if (direction === "backward" || direction === "both") {
      for (const n of await getBackwardNeighbors(backend, current.path)) {
        neighbors.push({ neighbor: n, from: n, to: current.path });
      }
    }

    for (const { neighbor, from, to } of neighbors) {
      const edgeType = classifyEdge(from, to);

      if (mode !== "all" && edgeType !== mode) {
        continue;
      }

      const alreadyHasEdge = edges.some((e) => e.from === from && e.to === to);
      if (!alreadyHasEdge) {
        edges.push({ from, to, type: edgeType });
      }

      if (!visited.has(neighbor)) {
        visited.add(neighbor);

        const info = await getFileInfo(backend, neighbor);
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

  const rootInfo = await getFileInfo(backend, root);
  if (rootInfo.outbound > 2) {
    branchingPoints.unshift(root);
  }

  return { root, nodes, edges, branchingPoints, maxDepthReached };
}
