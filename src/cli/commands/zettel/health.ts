/** zettel health: vault structural health audit. */

import type { Command } from "commander";
import chalk from "chalk";
import { ok, warn, err, dim, bold, header } from "../../utils.js";
import { getFedDb, shortPath } from "./utils.js";

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

  const { zettelHealth } = await import("../../../zettelkasten/index.js");
  const db = getFedDb();

  const result = zettelHealth(db, { scope, projectPath, recentDays, include: includeTypes });

  console.log();
  console.log(header("  PAI Zettel Health"));
  console.log(dim(`  Scope: ${scope}${scope === "project" ? `  Path: ${projectPath ?? "(none)"}` : ""}${scope === "recent" ? `  Days: ${recentDays}` : ""}`));
  console.log();

  const score = result.healthScore;
  const scoreColor = score >= 80 ? chalk.green : score >= 60 ? chalk.yellow : chalk.red;
  const barWidth = 30;
  const filled = Math.round((score / 100) * barWidth);
  const bar = scoreColor("█".repeat(filled)) + dim("░".repeat(barWidth - filled));
  console.log(`  Health Score: ${scoreColor(bold(String(score)))}%  [${bar}]`);
  console.log();
  console.log(dim(`  Files: ${result.totalFiles}   Links: ${result.totalLinks}`));
  console.log();

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

  if (result.disconnectedClusters <= 1) {
    console.log(ok("  Disconnected clusters: 1 (fully connected)"));
  } else {
    console.log(warn(`  Disconnected clusters: ${result.disconnectedClusters}`));
  }

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

export function registerHealthCommand(parent: Command): void {
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
}
