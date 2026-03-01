/**
 * pai zettel <sub-command>
 *
 * explore   — Follow link chains from a starting note
 * health    — Vault structural health audit
 * surprise  — Find surprising connections from a note
 * suggest   — Suggest new connections for a note
 * converse  — Ask the vault a question
 * themes    — Detect emerging themes in recent notes
 */

import type { Command } from "commander";
import type { Database } from "better-sqlite3";
import { ok, warn, err, dim, bold, header } from "../utils.js";
import { openFederation } from "../../memory/db.js";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Lazy federation DB — opened on first command that needs it
// ---------------------------------------------------------------------------

let _fedDb: Database | null = null;

function getFedDb(): Database {
  if (!_fedDb) {
    try {
      _fedDb = openFederation();
    } catch (e) {
      console.error(err(`Failed to open PAI federation DB: ${e}`));
      process.exit(1);
    }
  }
  return _fedDb;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorten a vault path to just the last 2-3 components for display. */
function shortPath(p: string, parts = 3): string {
  const segments = p.split("/").filter(Boolean);
  return segments.slice(-parts).join("/");
}

// ---------------------------------------------------------------------------
// Command: pai zettel explore <note>
// ---------------------------------------------------------------------------

async function cmdExplore(
  note: string,
  opts: { depth?: string; direction?: string; mode?: string }
): Promise<void> {
  const depth = parseInt(opts.depth ?? "3", 10);
  const direction = (opts.direction ?? "both") as "forward" | "backward" | "both";
  const mode = (opts.mode ?? "all") as "sequential" | "associative" | "all";

  const { zettelExplore } = await import("../../zettelkasten/index.js");
  const db = getFedDb();

  const result = zettelExplore(db, { startNote: note, depth, direction, mode });

  console.log();
  console.log(header("  PAI Zettel Explore"));
  console.log(dim(`  Starting note: ${note}`));
  console.log(dim(`  Depth: ${depth}  Direction: ${direction}  Mode: ${mode}`));
  console.log();

  if (result.nodes.length === 0) {
    console.log(warn("  No connected notes found. Check that the note path exists in the vault index."));
    console.log();
    return;
  }

  // Print root node
  console.log(`  ${chalk.cyan("●")} ${bold(shortPath(result.root))}  ${dim("(root)")}`);

  // Group nodes by depth and print tree-style
  const byDepth = new Map<number, typeof result.nodes>();
  for (const node of result.nodes) {
    const list = byDepth.get(node.depth) ?? [];
    list.push(node);
    byDepth.set(node.depth, list);
  }

  for (let d = 1; d <= depth; d++) {
    const nodes = byDepth.get(d) ?? [];
    if (nodes.length === 0) continue;

    console.log();
    console.log(dim(`  ${"  ".repeat(d - 1)}Depth ${d}:`));
    for (const node of nodes) {
      const indent = "  ".repeat(d);
      const isBranching = result.branchingPoints.includes(node.path);
      const typeColor = node.linkType === "sequential" ? chalk.blue : chalk.magenta;
      const branchMark = isBranching ? chalk.yellow(" ⑂ branching") : "";
      const title = node.title ?? shortPath(node.path);
      const stats = dim(`in:${node.inbound} out:${node.outbound}`);
      console.log(
        `  ${indent}${typeColor("→")} ${bold(title)}${branchMark}  ${stats}  ${dim(typeColor(node.linkType))}`
      );
    }
  }

  console.log();
  const edgeSummary = `${result.edges.length} edges  (${result.edges.filter(e => e.type === "sequential").length} sequential, ${result.edges.filter(e => e.type === "associative").length} associative)`;
  console.log(dim(`  ${edgeSummary}`));
  if (result.branchingPoints.length > 0) {
    console.log(ok(`  ${result.branchingPoints.length} branching point(s) found`));
  }
  if (result.maxDepthReached) {
    console.log(warn("  Max depth reached — use --depth to explore further"));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Command: pai zettel health
// ---------------------------------------------------------------------------

async function cmdHealth(opts: {
  scope?: string;
  project?: string;
  days?: string;
  include?: string;
}): Promise<void> {
  const scope = (opts.scope ?? "full") as "full" | "recent" | "project";
  const projectPath = opts.project;
  const recentDays = parseInt(opts.days ?? "30", 10);
  const includeTypes = opts.include
    ? (opts.include.split(",").map(s => s.trim()) as Array<"dead_links" | "orphans" | "disconnected" | "low_connectivity">)
    : undefined;

  const { zettelHealth } = await import("../../zettelkasten/index.js");
  const db = getFedDb();

  const result = zettelHealth(db, {
    scope,
    projectPath,
    recentDays,
    include: includeTypes,
  });

  console.log();
  console.log(header("  PAI Zettel Health"));
  console.log(dim(`  Scope: ${scope}${scope === "project" ? `  Path: ${projectPath ?? "(none)"}` : ""}${scope === "recent" ? `  Days: ${recentDays}` : ""}`));
  console.log();

  // Health score bar
  const score = result.healthScore;
  const scoreColor = score >= 80 ? chalk.green : score >= 60 ? chalk.yellow : chalk.red;
  const barWidth = 30;
  const filled = Math.round((score / 100) * barWidth);
  const bar = scoreColor("█".repeat(filled)) + dim("░".repeat(barWidth - filled));
  console.log(`  Health Score: ${scoreColor(bold(String(score)))}%  [${bar}]`);
  console.log();
  console.log(dim(`  Files: ${result.totalFiles}   Links: ${result.totalLinks}`));
  console.log();

  // Dead links
  if (result.deadLinks.length === 0) {
    console.log(ok("  Dead links:         none"));
  } else {
    console.log(warn(`  Dead links:         ${result.deadLinks.length}`));
    const preview = result.deadLinks.slice(0, 10);
    for (const dl of preview) {
      console.log(`    ${chalk.red("✗")} ${dim(shortPath(dl.sourcePath))} → ${bold(dl.targetRaw)} ${dim(`(line ${dl.lineNumber})`)}`);
    }
    if (result.deadLinks.length > 10) {
      console.log(dim(`    ... and ${result.deadLinks.length - 10} more`));
    }
    console.log();
  }

  // Orphans
  if (result.orphans.length === 0) {
    console.log(ok("  Orphan notes:       none"));
  } else {
    console.log(warn(`  Orphan notes:       ${result.orphans.length}`));
    const preview = result.orphans.slice(0, 10);
    for (const o of preview) {
      console.log(`    ${chalk.yellow("○")} ${dim(shortPath(o))}`);
    }
    if (result.orphans.length > 10) {
      console.log(dim(`    ... and ${result.orphans.length - 10} more`));
    }
    console.log();
  }

  // Disconnected clusters
  if (result.disconnectedClusters <= 1) {
    console.log(ok("  Disconnected clusters: 1 (fully connected)"));
  } else {
    console.log(warn(`  Disconnected clusters: ${result.disconnectedClusters}`));
  }

  // Low connectivity
  if (result.lowConnectivity.length === 0) {
    console.log(ok("  Low-connectivity:   none"));
  } else {
    console.log(warn(`  Low-connectivity:   ${result.lowConnectivity.length} note(s) with ≤1 link`));
    const preview = result.lowConnectivity.slice(0, 5);
    for (const lc of preview) {
      console.log(`    ${chalk.dim("—")} ${dim(shortPath(lc))}`);
    }
    if (result.lowConnectivity.length > 5) {
      console.log(dim(`    ... and ${result.lowConnectivity.length - 5} more`));
    }
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Command: pai zettel surprise <note>
// ---------------------------------------------------------------------------

async function cmdSurprise(
  note: string,
  opts: { vaultProjectId?: string; limit?: string; minSimilarity?: string; minDistance?: string }
): Promise<void> {
  if (!opts.vaultProjectId) {
    console.error(err("  --vault-project-id is required"));
    process.exit(1);
  }

  const vaultProjectId = parseInt(opts.vaultProjectId, 10);
  const limit = parseInt(opts.limit ?? "10", 10);
  const minSimilarity = parseFloat(opts.minSimilarity ?? "0.3");
  const minGraphDistance = parseInt(opts.minDistance ?? "3", 10);

  const { zettelSurprise } = await import("../../zettelkasten/index.js");
  const db = getFedDb();

  console.log();
  console.log(header("  PAI Zettel Surprise"));
  console.log(dim(`  Reference note: ${note}`));
  process.stdout.write(dim("  Searching for surprising connections...\n"));

  const results = await zettelSurprise(db, {
    referencePath: note,
    vaultProjectId,
    limit,
    minSimilarity,
    minGraphDistance,
  });

  if (results.length === 0) {
    console.log(warn("  No surprising connections found. Try lowering --min-similarity or --min-distance."));
    console.log();
    return;
  }

  console.log();
  console.log(bold(`  Found ${results.length} surprising connection(s):`));
  console.log();

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = r.title ?? shortPath(r.path);
    const surpriseBar = Math.round(r.surpriseScore * 10);
    console.log(`  ${chalk.cyan(String(i + 1).padStart(2, " "))}. ${bold(title)}`);
    console.log(`      ${dim("Surprise:")} ${chalk.magenta(r.surpriseScore.toFixed(3))} ${"■".repeat(surpriseBar)}${"□".repeat(10 - surpriseBar)}`);
    console.log(`      ${dim("Cosine:")} ${r.cosineSimilarity.toFixed(3)}   ${dim("Graph distance:")} ${r.graphDistance}`);
    if (r.sharedSnippet) {
      console.log(`      ${dim("Context:")} ${r.sharedSnippet.slice(0, 120)}`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Command: pai zettel suggest <note>
// ---------------------------------------------------------------------------

async function cmdSuggest(
  note: string,
  opts: { vaultProjectId?: string; limit?: string; excludeLinked?: boolean }
): Promise<void> {
  if (!opts.vaultProjectId) {
    console.error(err("  --vault-project-id is required"));
    process.exit(1);
  }

  const vaultProjectId = parseInt(opts.vaultProjectId, 10);
  const limit = parseInt(opts.limit ?? "5", 10);
  const excludeLinked = opts.excludeLinked !== false;

  const { zettelSuggest } = await import("../../zettelkasten/index.js");
  const db = getFedDb();

  console.log();
  console.log(header("  PAI Zettel Suggest"));
  console.log(dim(`  Note: ${note}`));
  process.stdout.write(dim("  Computing suggestions...\n"));

  const suggestions = await zettelSuggest(db, {
    notePath: note,
    vaultProjectId,
    limit,
    excludeLinked,
  });

  if (suggestions.length === 0) {
    console.log(warn("  No suggestions found. The note may be well-connected already."));
    console.log();
    return;
  }

  console.log();
  console.log(bold(`  ${suggestions.length} suggested connection(s):`));
  console.log();

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const title = s.title ?? shortPath(s.path);
    console.log(`  ${chalk.green(String(i + 1).padStart(2, " "))}. ${bold(title)}`);
    console.log(`      ${dim("Score:")} ${chalk.green(s.score.toFixed(3))}  ${dim("Semantic:")} ${s.semanticScore.toFixed(2)}  ${dim("Tag:")} ${s.tagScore.toFixed(2)}  ${dim("Neighbor:")} ${s.neighborScore.toFixed(2)}`);
    console.log(`      ${dim("Reason:")} ${s.reason}`);
    console.log(`      ${dim("Wikilink:")} ${chalk.cyan(s.suggestedWikilink)}`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Command: pai zettel converse <question>
// ---------------------------------------------------------------------------

async function cmdConverse(
  question: string,
  opts: { vaultProjectId?: string; depth?: string; limit?: string }
): Promise<void> {
  if (!opts.vaultProjectId) {
    console.error(err("  --vault-project-id is required"));
    process.exit(1);
  }

  const vaultProjectId = parseInt(opts.vaultProjectId, 10);
  const depth = parseInt(opts.depth ?? "2", 10);
  const limit = parseInt(opts.limit ?? "15", 10);

  const { zettelConverse } = await import("../../zettelkasten/index.js");
  const db = getFedDb();

  console.log();
  console.log(header("  PAI Zettel Converse"));
  console.log(dim(`  Question: "${question}"`));
  process.stdout.write(dim("  Searching vault for relevant notes...\n"));

  const result = await zettelConverse(db, {
    question,
    vaultProjectId,
    depth,
    limit,
  });

  if (result.relevantNotes.length === 0) {
    console.log(warn("  No relevant notes found. Try rephrasing your question."));
    console.log();
    return;
  }

  // Relevant notes
  console.log();
  console.log(bold(`  ${result.relevantNotes.length} relevant note(s) from ${result.domains.length} domain(s):`));
  console.log(dim(`  Domains: ${result.domains.join(", ")}`));
  console.log();

  for (const note of result.relevantNotes) {
    const title = note.title ?? shortPath(note.path);
    console.log(`  ${chalk.cyan("◆")} ${bold(title)}  ${dim(`[${note.domain}]  score: ${note.score.toFixed(3)}`)}`);
    if (note.snippet) {
      console.log(`    ${dim(note.snippet.slice(0, 200))}`);
    }
    console.log();
  }

  // Cross-domain connections
  if (result.connections.length > 0) {
    console.log(bold("  Cross-domain connections:"));
    for (const conn of result.connections.slice(0, 10)) {
      console.log(
        `  ${chalk.magenta("⟷")} ${dim(conn.fromDomain)} ${chalk.dim("→")} ${dim(conn.toDomain)}  ` +
        `${dim(shortPath(conn.fromPath))} → ${dim(shortPath(conn.toPath))}  ` +
        `${dim(`strength: ${conn.strength}`)}`
      );
    }
    console.log();
  }

  // Synthesis prompt
  console.log(bold("  Synthesis prompt (paste into your AI):"));
  console.log();
  const promptLines = result.synthesisPrompt.split("\n");
  for (const line of promptLines) {
    console.log(`  ${dim(line)}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Command: pai zettel themes
// ---------------------------------------------------------------------------

async function cmdThemes(opts: {
  vaultProjectId?: string;
  days?: string;
  minSize?: string;
  maxThemes?: string;
  threshold?: string;
}): Promise<void> {
  if (!opts.vaultProjectId) {
    console.error(err("  --vault-project-id is required"));
    process.exit(1);
  }

  const vaultProjectId = parseInt(opts.vaultProjectId, 10);
  const lookbackDays = parseInt(opts.days ?? "30", 10);
  const minClusterSize = parseInt(opts.minSize ?? "3", 10);
  const maxThemes = parseInt(opts.maxThemes ?? "10", 10);
  const similarityThreshold = parseFloat(opts.threshold ?? "0.65");

  const { zettelThemes } = await import("../../zettelkasten/index.js");
  const db = getFedDb();

  console.log();
  console.log(header("  PAI Zettel Themes"));
  console.log(dim(`  Lookback: ${lookbackDays}d  Min cluster: ${minClusterSize}  Threshold: ${similarityThreshold}`));
  process.stdout.write(dim("  Detecting emerging themes...\n"));

  const result = await zettelThemes(db, {
    vaultProjectId,
    lookbackDays,
    minClusterSize,
    maxThemes,
    similarityThreshold,
  });

  if (result.themes.length === 0) {
    console.log(warn(`  No themes detected in the last ${lookbackDays} days. Try --days with a larger window.`));
    console.log();
    return;
  }

  const fromDate = new Date(result.timeWindow.from).toISOString().slice(0, 10);
  const toDate = new Date(result.timeWindow.to).toISOString().slice(0, 10);

  console.log();
  console.log(bold(`  ${result.themes.length} theme(s) from ${result.totalNotesAnalyzed} notes  [${fromDate} → ${toDate}]:`));
  console.log();

  for (let i = 0; i < result.themes.length; i++) {
    const cluster = result.themes[i];
    const diversityBar = Math.round(cluster.folderDiversity * 10);
    const indexSuggestion = cluster.suggestIndexNote
      ? chalk.yellow("  ⚑ suggest index note")
      : "";

    console.log(`  ${chalk.cyan(String(i + 1).padStart(2, " "))}. ${bold(cluster.label)}${indexSuggestion}`);
    console.log(
      `      ${dim("Notes:")} ${cluster.size}  ` +
      `${dim("Diversity:")} ${"█".repeat(diversityBar)}${"░".repeat(10 - diversityBar)} ${cluster.folderDiversity.toFixed(2)}  ` +
      `${dim("Linked:")} ${Math.round(cluster.linkedRatio * 100)}%`
    );

    // Show up to 5 notes per cluster
    const preview = cluster.notes.slice(0, 5);
    for (const note of preview) {
      const title = note.title ?? shortPath(note.path);
      console.log(`      ${dim("•")} ${title}`);
    }
    if (cluster.notes.length > 5) {
      console.log(dim(`      ... and ${cluster.notes.length - 5} more`));
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerZettelCommands(
  parent: Command,
  _getDb: () => Database   // registry DB (unused — we open federation DB directly)
): void {
  // pai zettel explore <note>
  parent
    .command("explore <note>")
    .description("Follow link chains from a starting note")
    .option("--depth <n>", "Maximum traversal depth (1-10)", "3")
    .option("--direction <d>", "Link direction: forward | backward | both", "both")
    .option("--mode <m>", "Edge mode: sequential | associative | all", "all")
    .action(async (note: string, opts: { depth?: string; direction?: string; mode?: string }) => {
      try {
        await cmdExplore(note, opts);
      } catch (e) {
        console.error(err(`  Error: ${e}`));
        process.exit(1);
      }
    });

  // pai zettel health
  parent
    .command("health")
    .description("Vault structural health audit: dead links, orphans, connectivity")
    .option("--scope <s>", "Scope: full | recent | project", "full")
    .option("--project <path>", "Project path prefix (requires --scope project)")
    .option("--days <n>", "Look-back window in days (requires --scope recent)", "30")
    .option("--include <types>", "Comma-separated subset: dead_links,orphans,disconnected,low_connectivity")
    .action(async (opts: { scope?: string; project?: string; days?: string; include?: string }) => {
      try {
        await cmdHealth(opts);
      } catch (e) {
        console.error(err(`  Error: ${e}`));
        process.exit(1);
      }
    });

  // pai zettel surprise <note>
  parent
    .command("surprise <note>")
    .description("Find semantically similar but graph-distant notes (surprising connections)")
    .requiredOption("--vault-project-id <n>", "Project ID for the vault in the federation DB")
    .option("--limit <n>", "Maximum results", "10")
    .option("--min-similarity <f>", "Minimum cosine similarity (0–1)", "0.3")
    .option("--min-distance <n>", "Minimum graph distance", "3")
    .action(async (note: string, opts: { vaultProjectId?: string; limit?: string; minSimilarity?: string; minDistance?: string }) => {
      try {
        await cmdSurprise(note, opts);
      } catch (e) {
        console.error(err(`  Error: ${e}`));
        process.exit(1);
      }
    });

  // pai zettel suggest <note>
  parent
    .command("suggest <note>")
    .description("Suggest new wikilink connections for a note")
    .requiredOption("--vault-project-id <n>", "Project ID for the vault in the federation DB")
    .option("--limit <n>", "Maximum suggestions", "5")
    .option("--no-exclude-linked", "Include notes already linked from this one")
    .action(async (note: string, opts: { vaultProjectId?: string; limit?: string; excludeLinked?: boolean }) => {
      try {
        await cmdSuggest(note, opts);
      } catch (e) {
        console.error(err(`  Error: ${e}`));
        process.exit(1);
      }
    });

  // pai zettel converse <question>
  parent
    .command("converse <question>")
    .description("Ask the vault a question and get a synthesis prompt with relevant notes")
    .requiredOption("--vault-project-id <n>", "Project ID for the vault in the federation DB")
    .option("--depth <n>", "Graph expansion depth around matched notes", "2")
    .option("--limit <n>", "Maximum relevant notes to include", "15")
    .action(async (question: string, opts: { vaultProjectId?: string; depth?: string; limit?: string }) => {
      try {
        await cmdConverse(question, opts);
      } catch (e) {
        console.error(err(`  Error: ${e}`));
        process.exit(1);
      }
    });

  // pai zettel themes
  parent
    .command("themes")
    .description("Detect emerging theme clusters in recently edited notes")
    .requiredOption("--vault-project-id <n>", "Project ID for the vault in the federation DB")
    .option("--days <n>", "Look-back window in days", "30")
    .option("--min-size <n>", "Minimum notes per cluster", "3")
    .option("--max-themes <n>", "Maximum themes to return", "10")
    .option("--threshold <f>", "Similarity threshold for clustering (0–1)", "0.65")
    .action(async (opts: { vaultProjectId?: string; days?: string; minSize?: string; maxThemes?: string; threshold?: string }) => {
      try {
        await cmdThemes(opts);
      } catch (e) {
        console.error(err(`  Error: ${e}`));
        process.exit(1);
      }
    });
}
