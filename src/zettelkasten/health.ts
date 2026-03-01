import type { Database } from "better-sqlite3";

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

function buildScopeFilter(
  opts: HealthOptions,
  tableAlias: string,
  pathColumn: string,
): { clause: string; params: unknown[] } {
  const scope = opts.scope ?? "full";

  if (scope === "project") {
    const prefix = opts.projectPath ?? "";
    return {
      clause: `WHERE ${tableAlias}.${pathColumn} LIKE ? || '%'`,
      params: [prefix],
    };
  }

  if (scope === "recent") {
    const days = opts.recentDays ?? 30;
    const cutoff = Date.now() - days * 86400000;
    return {
      clause: `WHERE ${tableAlias}.indexed_at > ?`,
      params: [cutoff],
    };
  }

  return { clause: "", params: [] };
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
 * Designed to complete in under 60ms for a full vault.
 */
export function zettelHealth(db: Database, opts?: HealthOptions): HealthResult {
  const options = opts ?? {};
  const scope = options.scope ?? "full";
  const include = options.include ?? ["dead_links", "orphans", "disconnected", "low_connectivity"];

  const computedAt = Date.now();

  // --- totalFiles ---
  let totalFiles = 0;
  if (scope === "full") {
    totalFiles = (
      db.prepare("SELECT COUNT(*) AS n FROM vault_files").get() as { n: number }
    ).n;
  } else if (scope === "project") {
    const prefix = options.projectPath ?? "";
    totalFiles = (
      db
        .prepare("SELECT COUNT(*) AS n FROM vault_files WHERE vault_path LIKE ? || '%'")
        .get(prefix) as { n: number }
    ).n;
  } else {
    const days = options.recentDays ?? 30;
    const cutoff = computedAt - days * 86400000;
    totalFiles = (
      db
        .prepare("SELECT COUNT(*) AS n FROM vault_files WHERE indexed_at > ?")
        .get(cutoff) as { n: number }
    ).n;
  }

  // --- totalLinks ---
  let totalLinks = 0;
  if (scope === "full") {
    totalLinks = (
      db.prepare("SELECT COUNT(*) AS n FROM vault_links").get() as { n: number }
    ).n;
  } else if (scope === "project") {
    const prefix = options.projectPath ?? "";
    totalLinks = (
      db
        .prepare("SELECT COUNT(*) AS n FROM vault_links WHERE source_path LIKE ? || '%'")
        .get(prefix) as { n: number }
    ).n;
  } else {
    const days = options.recentDays ?? 30;
    const cutoff = computedAt - days * 86400000;
    totalLinks = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM vault_links WHERE source_path IN (SELECT vault_path FROM vault_files WHERE indexed_at > ?)",
        )
        .get(cutoff) as { n: number }
    ).n;
  }

  // --- deadLinks ---
  let deadLinks: DeadLink[] = [];
  if (include.includes("dead_links")) {
    if (scope === "full") {
      deadLinks = (
        db
          .prepare(
            "SELECT source_path, target_raw, line_number FROM vault_links WHERE target_path IS NULL",
          )
          .all() as Array<{ source_path: string; target_raw: string; line_number: number }>
      ).map((r) => ({
        sourcePath: r.source_path,
        targetRaw: r.target_raw,
        lineNumber: r.line_number,
      }));
    } else if (scope === "project") {
      const prefix = options.projectPath ?? "";
      deadLinks = (
        db
          .prepare(
            "SELECT source_path, target_raw, line_number FROM vault_links WHERE target_path IS NULL AND source_path LIKE ? || '%'",
          )
          .all(prefix) as Array<{ source_path: string; target_raw: string; line_number: number }>
      ).map((r) => ({
        sourcePath: r.source_path,
        targetRaw: r.target_raw,
        lineNumber: r.line_number,
      }));
    } else {
      const days = options.recentDays ?? 30;
      const cutoff = computedAt - days * 86400000;
      deadLinks = (
        db
          .prepare(
            "SELECT source_path, target_raw, line_number FROM vault_links WHERE target_path IS NULL AND source_path IN (SELECT vault_path FROM vault_files WHERE indexed_at > ?)",
          )
          .all(cutoff) as Array<{ source_path: string; target_raw: string; line_number: number }>
      ).map((r) => ({
        sourcePath: r.source_path,
        targetRaw: r.target_raw,
        lineNumber: r.line_number,
      }));
    }
  }

  // --- orphans ---
  let orphans: string[] = [];
  if (include.includes("orphans")) {
    if (scope === "full") {
      orphans = (
        db
          .prepare("SELECT vault_path FROM vault_health WHERE is_orphan = 1")
          .all() as Array<{ vault_path: string }>
      ).map((r) => r.vault_path);
    } else if (scope === "project") {
      const prefix = options.projectPath ?? "";
      orphans = (
        db
          .prepare(
            "SELECT vault_path FROM vault_health WHERE is_orphan = 1 AND vault_path LIKE ? || '%'",
          )
          .all(prefix) as Array<{ vault_path: string }>
      ).map((r) => r.vault_path);
    } else {
      const days = options.recentDays ?? 30;
      const cutoff = computedAt - days * 86400000;
      orphans = (
        db
          .prepare(
            "SELECT vh.vault_path FROM vault_health vh JOIN vault_files vf ON vh.vault_path = vf.vault_path WHERE vh.is_orphan = 1 AND vf.indexed_at > ?",
          )
          .all(cutoff) as Array<{ vault_path: string }>
      ).map((r) => r.vault_path);
    }
  }

  // --- disconnectedClusters (union-find) ---
  let disconnectedClusters = 1;
  if (include.includes("disconnected")) {
    let allNodes: string[];
    let allEdges: Array<{ source: string; target: string }>;

    if (scope === "full") {
      allNodes = (
        db.prepare("SELECT vault_path FROM vault_files").all() as Array<{ vault_path: string }>
      ).map((r) => r.vault_path);

      allEdges = (
        db
          .prepare(
            "SELECT DISTINCT source_path AS source, target_path AS target FROM vault_links WHERE target_path IS NOT NULL",
          )
          .all() as Array<{ source: string; target: string }>
      );
    } else if (scope === "project") {
      const prefix = options.projectPath ?? "";
      allNodes = (
        db
          .prepare("SELECT vault_path FROM vault_files WHERE vault_path LIKE ? || '%'")
          .all(prefix) as Array<{ vault_path: string }>
      ).map((r) => r.vault_path);

      allEdges = (
        db
          .prepare(
            "SELECT DISTINCT source_path AS source, target_path AS target FROM vault_links WHERE target_path IS NOT NULL AND source_path LIKE ? || '%'",
          )
          .all(prefix) as Array<{ source: string; target: string }>
      );
    } else {
      const days = options.recentDays ?? 30;
      const cutoff = computedAt - days * 86400000;
      allNodes = (
        db
          .prepare("SELECT vault_path FROM vault_files WHERE indexed_at > ?")
          .all(cutoff) as Array<{ vault_path: string }>
      ).map((r) => r.vault_path);

      allEdges = (
        db
          .prepare(
            "SELECT DISTINCT source_path AS source, target_path AS target FROM vault_links WHERE target_path IS NOT NULL AND source_path IN (SELECT vault_path FROM vault_files WHERE indexed_at > ?)",
          )
          .all(cutoff) as Array<{ source: string; target: string }>
      );
    }

    disconnectedClusters = countComponents(allNodes, allEdges);
  }

  // --- lowConnectivity ---
  let lowConnectivity: string[] = [];
  if (include.includes("low_connectivity")) {
    if (scope === "full") {
      lowConnectivity = (
        db
          .prepare(
            "SELECT vault_path FROM vault_health WHERE inbound_count + outbound_count <= 1",
          )
          .all() as Array<{ vault_path: string }>
      ).map((r) => r.vault_path);
    } else if (scope === "project") {
      const prefix = options.projectPath ?? "";
      lowConnectivity = (
        db
          .prepare(
            "SELECT vault_path FROM vault_health WHERE inbound_count + outbound_count <= 1 AND vault_path LIKE ? || '%'",
          )
          .all(prefix) as Array<{ vault_path: string }>
      ).map((r) => r.vault_path);
    } else {
      const days = options.recentDays ?? 30;
      const cutoff = computedAt - days * 86400000;
      lowConnectivity = (
        db
          .prepare(
            "SELECT vh.vault_path FROM vault_health vh JOIN vault_files vf ON vh.vault_path = vf.vault_path WHERE vh.inbound_count + vh.outbound_count <= 1 AND vf.indexed_at > ?",
          )
          .all(cutoff) as Array<{ vault_path: string }>
      ).map((r) => r.vault_path);
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
