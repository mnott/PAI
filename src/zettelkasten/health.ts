import type { StorageBackend } from "../storage/interface.js";

export interface HealthOptions {
  scope?: "full" | "recent" | "project";
  projectPath?: string;
  recentDays?: number;
  include?: Array<"dead_links" | "orphans" | "disconnected" | "low_connectivity">;
}

export interface DeadLink {
  sourcePath: string;
  targetRaw: string;
  lineNumber: number;
}

export interface HealthResult {
  totalFiles: number;
  totalLinks: number;
  deadLinks: DeadLink[];
  orphans: string[];
  disconnectedClusters: number;
  lowConnectivity: string[];
  healthScore: number;
  computedAt: number;
}

function countComponents(nodes: string[], edges: Array<{ source: string; target: string }>): number {
  if (nodes.length === 0) return 0;

  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  for (const n of nodes) {
    parent.set(n, n);
    rank.set(n, 0);
  }

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let current = x;
    while (current !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const rankA = rank.get(ra) ?? 0;
    const rankB = rank.get(rb) ?? 0;
    if (rankA < rankB) {
      parent.set(ra, rb);
    } else if (rankA > rankB) {
      parent.set(rb, ra);
    } else {
      parent.set(rb, ra);
      rank.set(ra, rankA + 1);
    }
  }

  for (const { source, target } of edges) {
    if (parent.has(source) && parent.has(target)) {
      union(source, target);
    }
  }

  const roots = new Set<string>();
  for (const n of nodes) {
    roots.add(find(n));
  }
  return roots.size;
}

/**
 * Audit the structural health of the Zettelkasten vault using graph metrics.
 */
export async function zettelHealth(backend: StorageBackend, opts?: HealthOptions): Promise<HealthResult> {
  const options = opts ?? {};
  const scope = options.scope ?? "full";
  const include = options.include ?? ["dead_links", "orphans", "disconnected", "low_connectivity"];

  const computedAt = Date.now();

  // --- totalFiles ---
  let totalFiles = 0;
  if (scope === "full") {
    totalFiles = await backend.countVaultFiles();
  } else if (scope === "project") {
    const prefix = options.projectPath ?? "";
    totalFiles = await backend.countVaultFilesWithPrefix(prefix);
  } else {
    const days = options.recentDays ?? 30;
    const cutoff = computedAt - days * 86400000;
    totalFiles = await backend.countVaultFilesAfter(cutoff);
  }

  // --- totalLinks ---
  let totalLinks = 0;
  if (scope === "full") {
    // Count total links via link graph length
    const graph = await backend.getVaultLinkGraph();
    totalLinks = graph.length;
  } else if (scope === "project") {
    const prefix = options.projectPath ?? "";
    totalLinks = await backend.countVaultLinksWithPrefix(prefix);
  } else {
    const days = options.recentDays ?? 30;
    const cutoff = computedAt - days * 86400000;
    totalLinks = await backend.countVaultLinksAfter(cutoff);
  }

  // --- deadLinks ---
  let deadLinks: DeadLink[] = [];
  if (include.includes("dead_links")) {
    if (scope === "full") {
      deadLinks = await backend.getDeadLinksWithLineNumbers();
    } else if (scope === "project") {
      const prefix = options.projectPath ?? "";
      deadLinks = await backend.getDeadLinksWithPrefix(prefix);
    } else {
      const days = options.recentDays ?? 30;
      const cutoff = computedAt - days * 86400000;
      deadLinks = await backend.getDeadLinksAfter(cutoff);
    }
  }

  // --- orphans ---
  let orphans: string[] = [];
  if (include.includes("orphans")) {
    if (scope === "full") {
      const orphanRows = await backend.getOrphans();
      orphans = orphanRows.map(r => r.vaultPath);
    } else if (scope === "project") {
      const prefix = options.projectPath ?? "";
      orphans = await backend.getOrphansWithPrefix(prefix);
    } else {
      const days = options.recentDays ?? 30;
      const cutoff = computedAt - days * 86400000;
      orphans = await backend.getOrphansAfter(cutoff);
    }
  }

  // --- disconnectedClusters (union-find) ---
  let disconnectedClusters = 1;
  if (include.includes("disconnected")) {
    let allNodes: string[];
    let allEdges: Array<{ source: string; target: string }>;

    if (scope === "full") {
      [allNodes, allEdges] = await Promise.all([
        backend.getAllVaultFilePaths(),
        backend.getVaultLinkEdges(),
      ]);
    } else if (scope === "project") {
      const prefix = options.projectPath ?? "";
      [allNodes, allEdges] = await Promise.all([
        backend.getVaultFilePathsWithPrefix(prefix),
        backend.getVaultLinkEdgesWithPrefix(prefix),
      ]);
    } else {
      const days = options.recentDays ?? 30;
      const cutoff = computedAt - days * 86400000;
      [allNodes, allEdges] = await Promise.all([
        backend.getVaultFilePathsAfter(cutoff),
        backend.getVaultLinkEdgesAfter(cutoff),
      ]);
    }

    disconnectedClusters = countComponents(allNodes, allEdges);
  }

  // --- lowConnectivity ---
  let lowConnectivity: string[] = [];
  if (include.includes("low_connectivity")) {
    if (scope === "full") {
      lowConnectivity = await backend.getLowConnectivity();
    } else if (scope === "project") {
      const prefix = options.projectPath ?? "";
      lowConnectivity = await backend.getLowConnectivityWithPrefix(prefix);
    } else {
      const days = options.recentDays ?? 30;
      const cutoff = computedAt - days * 86400000;
      lowConnectivity = await backend.getLowConnectivityAfter(cutoff);
    }
  }

  // --- healthScore ---
  const deadRatio = totalLinks > 0 ? deadLinks.length / totalLinks : 0;
  const orphanRatio = totalFiles > 0 ? orphans.length / totalFiles : 0;
  const lowConnRatio = totalFiles > 0 ? lowConnectivity.length / totalFiles : 0;
  const healthScore = Math.round(
    100 * (1 - deadRatio) * (1 - orphanRatio * 0.5) * (1 - lowConnRatio * 0.3),
  );

  return {
    totalFiles,
    totalLinks,
    deadLinks,
    orphans,
    disconnectedClusters,
    lowConnectivity,
    healthScore,
    computedAt,
  };
}
