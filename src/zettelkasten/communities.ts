/**
 * Community detection for the Zettelkasten vault link graph.
 *
 * Implements the Louvain algorithm in pure TypeScript for discovering
 * densely connected clusters of notes. This reveals emergent knowledge
 * communities that may not be obvious from folder structure alone.
 *
 * The Louvain method optimizes modularity in two phases:
 *  1. Local: each node greedily moves to the community that maximizes modularity gain.
 *  2. Aggregation: communities are collapsed into super-nodes, forming a new graph.
 * Repeat until no further improvement.
 */

import type { StorageBackend } from "../storage/interface.js";

export interface CommunityOptions {
  /** Minimum community size to include in results. Default: 3. */
  minSize?: number;
  /** Maximum number of communities to return. Default: 20. */
  maxCommunities?: number;
  /** Resolution parameter for Louvain (higher = more communities). Default: 1.0. */
  resolution?: number;
}

export interface CommunityNode {
  path: string;
  title: string | null;
  /** Degree (inbound + outbound) within the community. */
  internalDegree: number;
}

export interface Community {
  id: number;
  /** Label derived from most common words in note titles. */
  label: string;
  nodes: CommunityNode[];
  size: number;
  /** Cohesion: ratio of internal edges to total possible internal edges. */
  cohesion: number;
  /** Top folders represented in this community. */
  topFolders: string[];
}

export interface CommunityResult {
  communities: Community[];
  totalNodes: number;
  totalEdges: number;
  /** Global modularity score of the partition. */
  modularity: number;
}

// ---------------------------------------------------------------------------
// Louvain algorithm implementation
// ---------------------------------------------------------------------------

interface Graph {
  /** All node IDs */
  nodes: string[];
  /** Adjacency list: node -> Map<neighbor, weight> */
  adj: Map<string, Map<string, number>>;
  /** Total edge weight (sum of all edge weights, counting undirected edges once) */
  totalWeight: number;
  /** Weighted degree per node */
  degree: Map<string, number>;
}

function buildUndirectedGraph(
  edges: Array<{ source_path: string; target_path: string }>
): Graph {
  const adj = new Map<string, Map<string, number>>();
  const nodeSet = new Set<string>();

  function getOrCreate(node: string): Map<string, number> {
    let m = adj.get(node);
    if (!m) {
      m = new Map();
      adj.set(node, m);
    }
    nodeSet.add(node);
    return m;
  }

  let totalWeight = 0;

  for (const { source_path, target_path } of edges) {
    if (source_path === target_path) continue; // skip self-loops

    const aMap = getOrCreate(source_path);
    const bMap = getOrCreate(target_path);

    // Undirected: add weight in both directions
    aMap.set(target_path, (aMap.get(target_path) ?? 0) + 1);
    bMap.set(source_path, (bMap.get(source_path) ?? 0) + 1);
    totalWeight += 1; // each undirected edge counted once
  }

  // Compute weighted degree
  const degree = new Map<string, number>();
  for (const [node, neighbors] of adj) {
    let d = 0;
    for (const w of neighbors.values()) d += w;
    degree.set(node, d);
  }

  return {
    nodes: Array.from(nodeSet),
    adj,
    totalWeight,
    degree,
  };
}

/**
 * Run one pass of Phase 1: local node movement.
 * Returns true if any node changed community.
 */
function louvainPhase1(
  graph: Graph,
  community: Map<string, number>,
  resolution: number,
): boolean {
  const m2 = 2 * graph.totalWeight;
  if (m2 === 0) return false;

  // Community -> sum of degrees of nodes in community
  const communityDegreeSum = new Map<number, number>();
  // Community -> sum of internal edge weights
  const communityInternalWeight = new Map<number, number>();

  for (const node of graph.nodes) {
    const c = community.get(node)!;
    communityDegreeSum.set(c, (communityDegreeSum.get(c) ?? 0) + (graph.degree.get(node) ?? 0));
  }

  // Compute internal weights
  for (const [node, neighbors] of graph.adj) {
    const nc = community.get(node)!;
    for (const [neighbor, weight] of neighbors) {
      if (community.get(neighbor) === nc) {
        communityInternalWeight.set(nc, (communityInternalWeight.get(nc) ?? 0) + weight);
      }
    }
  }
  // Each internal edge is counted twice (both endpoints), so divide
  for (const [c, w] of communityInternalWeight) {
    communityInternalWeight.set(c, w / 2);
  }

  let improved = false;
  // Shuffle node order for better convergence
  const shuffled = [...graph.nodes];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const node of shuffled) {
    const currentComm = community.get(node)!;
    const ki = graph.degree.get(node) ?? 0;
    const neighbors = graph.adj.get(node) ?? new Map();

    // Compute weight to each neighboring community
    const weightToComm = new Map<number, number>();
    for (const [neighbor, weight] of neighbors) {
      const nc = community.get(neighbor)!;
      weightToComm.set(nc, (weightToComm.get(nc) ?? 0) + weight);
    }

    // Remove node from its current community
    communityDegreeSum.set(currentComm, (communityDegreeSum.get(currentComm) ?? 0) - ki);
    const weightToCurrent = weightToComm.get(currentComm) ?? 0;
    communityInternalWeight.set(
      currentComm,
      (communityInternalWeight.get(currentComm) ?? 0) - weightToCurrent,
    );

    // Find best community
    let bestComm = currentComm;
    let bestDelta = 0;

    for (const [candidateComm, weightToCandidate] of weightToComm) {
      const sigmaTot = communityDegreeSum.get(candidateComm) ?? 0;
      // Modularity gain of moving node to candidateComm
      const delta = weightToCandidate - resolution * (ki * sigmaTot) / m2;
      if (delta > bestDelta) {
        bestDelta = delta;
        bestComm = candidateComm;
      }
    }

    // Also consider staying (delta = 0, but need to re-add)
    // Move node to best community
    community.set(node, bestComm);
    communityDegreeSum.set(bestComm, (communityDegreeSum.get(bestComm) ?? 0) + ki);
    const weightToBest = weightToComm.get(bestComm) ?? 0;
    communityInternalWeight.set(
      bestComm,
      (communityInternalWeight.get(bestComm) ?? 0) + weightToBest,
    );

    if (bestComm !== currentComm) {
      improved = true;
    }
  }

  return improved;
}

/**
 * Compute modularity for a given partition.
 */
function computeModularity(
  graph: Graph,
  community: Map<string, number>,
  resolution: number,
): number {
  const m2 = 2 * graph.totalWeight;
  if (m2 === 0) return 0;

  let q = 0;
  for (const [node, neighbors] of graph.adj) {
    const ci = community.get(node)!;
    const ki = graph.degree.get(node) ?? 0;

    for (const [neighbor, weight] of neighbors) {
      if (community.get(neighbor) === ci) {
        q += weight - resolution * (ki * (graph.degree.get(neighbor) ?? 0)) / m2;
      }
    }
  }
  return q / m2;
}

/**
 * Run Louvain community detection on the vault link graph.
 */
function runLouvain(
  graph: Graph,
  resolution: number,
): Map<string, number> {
  // Initialize: each node in its own community
  const community = new Map<string, number>();
  let nextComm = 0;
  for (const node of graph.nodes) {
    community.set(node, nextComm++);
  }

  // Phase 1: iteratively move nodes until no improvement
  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const improved = louvainPhase1(graph, community, resolution);
    if (!improved) break;
  }

  // Compact community IDs
  const commRemap = new Map<number, number>();
  let remapIdx = 0;
  for (const [, c] of community) {
    if (!commRemap.has(c)) {
      commRemap.set(c, remapIdx++);
    }
  }
  for (const [node, c] of community) {
    community.set(node, commRemap.get(c)!);
  }

  return community;
}

// ---------------------------------------------------------------------------
// Label generation
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her",
  "was", "one", "our", "out", "has", "had", "how", "its", "may", "new",
  "now", "old", "see", "way", "who", "did", "get", "let", "say", "she",
  "too", "use", "from", "with", "this", "that", "will", "been", "have",
  "each", "make", "like", "long", "look", "many", "them", "then", "what",
  "when", "some", "time", "very", "your", "about", "could", "into", "just",
  "more", "note", "notes", "than", "over",
]);

function generateCommunityLabel(titles: Array<string | null>): string {
  const wordCounts = new Map<string, number>();
  for (const title of titles) {
    if (!title) continue;
    const words = title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }
  const sorted = [...wordCounts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted
    .slice(0, 3)
    .map(([w]) => w)
    .join(" / ") || "unnamed";
}

function getTopFolder(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Detect communities in the vault link graph using the Louvain algorithm.
 * Returns clusters of densely connected notes with labels and cohesion scores.
 */
export async function zettelCommunities(
  backend: StorageBackend,
  opts?: CommunityOptions,
): Promise<CommunityResult> {
  const minSize = opts?.minSize ?? 3;
  const maxCommunities = opts?.maxCommunities ?? 20;
  const resolution = opts?.resolution ?? 1.0;

  // Get the full link graph
  const linkGraph = await backend.getVaultLinkGraph();
  const graph = buildUndirectedGraph(linkGraph);

  if (graph.nodes.length === 0) {
    return {
      communities: [],
      totalNodes: 0,
      totalEdges: 0,
      modularity: 0,
    };
  }

  // Run Louvain
  const communityMap = runLouvain(graph, resolution);

  // Compute modularity
  const modularity = computeModularity(graph, communityMap, resolution);

  // Group nodes by community
  const groups = new Map<number, string[]>();
  for (const [node, comm] of communityMap) {
    const arr = groups.get(comm);
    if (arr) arr.push(node);
    else groups.set(comm, [node]);
  }

  // Get all vault files for title lookup
  const allFiles = await backend.getAllVaultFiles();
  const titleMap = new Map<string, string | null>();
  for (const f of allFiles) {
    titleMap.set(f.vaultPath, f.title);
  }

  // Build community results
  const communities: Community[] = [];
  let commId = 0;

  for (const [, members] of groups) {
    if (members.length < minSize) continue;

    const memberSet = new Set(members);
    const titles = members.map((p) => titleMap.get(p) ?? null);
    const label = generateCommunityLabel(titles);

    // Compute internal degree per node
    const nodes: CommunityNode[] = members.map((path) => {
      const neighbors = graph.adj.get(path) ?? new Map();
      let internalDeg = 0;
      for (const [neighbor, weight] of neighbors) {
        if (memberSet.has(neighbor)) internalDeg += weight;
      }
      return {
        path,
        title: titleMap.get(path) ?? null,
        internalDegree: internalDeg,
      };
    });

    // Sort nodes by internal degree descending
    nodes.sort((a, b) => b.internalDegree - a.internalDegree);

    // Compute cohesion: ratio of actual internal edges to possible
    let internalEdges = 0;
    for (const node of nodes) {
      internalEdges += node.internalDegree;
    }
    internalEdges /= 2; // each edge counted twice
    const possibleEdges = (members.length * (members.length - 1)) / 2;
    const cohesion = possibleEdges > 0 ? Math.round((internalEdges / possibleEdges) * 1000) / 1000 : 0;

    // Top folders
    const folderCounts = new Map<string, number>();
    for (const path of members) {
      const folder = getTopFolder(path);
      folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    }
    const topFolders = [...folderCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([f]) => f);

    communities.push({
      id: commId++,
      label,
      nodes,
      size: members.length,
      cohesion,
      topFolders,
    });
  }

  // Sort by size descending
  communities.sort((a, b) => b.size - a.size);

  return {
    communities: communities.slice(0, maxCommunities),
    totalNodes: graph.nodes.length,
    totalEdges: graph.totalWeight,
    modularity: Math.round(modularity * 10000) / 10000,
  };
}
