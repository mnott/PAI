/** zettel themes: detect emerging theme clusters in recently edited notes. */

import type { Command } from "commander";
import chalk from "chalk";
import { warn, err, dim, bold, header } from "../../utils.js";
import { getFedDb, shortPath } from "./utils.js";

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

  const { zettelThemes } = await import("../../../zettelkasten/index.js");
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
    const indexSuggestion = cluster.suggestIndexNote ? chalk.yellow("  ⚑ suggest index note") : "";

    console.log(`  ${chalk.cyan(String(i + 1).padStart(2, " "))}. ${bold(cluster.label)}${indexSuggestion}`);
    console.log(
      `      ${dim("Notes:")} ${cluster.size}  ` +
      `${dim("Diversity:")} ${"█".repeat(diversityBar)}${"░".repeat(10 - diversityBar)} ${cluster.folderDiversity.toFixed(2)}  ` +
      `${dim("Linked:")} ${Math.round(cluster.linkedRatio * 100)}%`
    );

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

export function registerThemesCommand(parent: Command): void {
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
