/** zettel themes: detect emerging theme clusters in recently edited notes. */

import chalk from "chalk";
import { warn, err, dim, bold, header } from "../../lib/utils.js";
import { getFedBackend, shortPath } from "./utils.js";
import { CliError } from "../../define.js";

export async function zettelThemesCmd(opts: {
  vaultProjectId?: string | number;
  days?: number;
  minSize?: number;
  maxThemes?: number;
  threshold?: number
}): Promise<number> {
  if (opts.vaultProjectId === undefined) {
    throw new CliError("--vault-project-id is required", "pai help zettel themes", 1);
  }

  const vaultProjectId = Number(opts.vaultProjectId);
  const lookbackDays = opts.days ?? 30;
  const minClusterSize = opts.minSize ?? 3;
  const maxThemes = opts.maxThemes ?? 10;
  const similarityThreshold = opts.threshold ?? 0.65;

  const { zettelThemes } = await import("../../../zettelkasten/index.js");
  const backend = await getFedBackend();

  console.log();
  console.log(header("  PAI Zettel Themes"));
  console.log(dim(`  Lookback: ${lookbackDays}d  Min cluster: ${minClusterSize}  Threshold: ${similarityThreshold}`));
  process.stdout.write(dim("  Detecting emerging themes...\n"));

  const result = await zettelThemes(backend, {
    vaultProjectId,
    lookbackDays,
    minClusterSize,
    maxThemes,
    similarityThreshold,
  });

  if (result.themes.length === 0) {
    console.log(warn(`  No themes detected in the last ${lookbackDays} days. Try --days with a larger window.`));
    console.log();
    return 0;
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

  return 0;
}
