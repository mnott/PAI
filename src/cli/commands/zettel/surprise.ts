/** zettel surprise: find semantically similar but graph-distant notes. */

import type { Command } from "commander";
import chalk from "chalk";
import { warn, err, dim, bold, header } from "../../utils.js";
import { getFedDb, shortPath } from "./utils.js";

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

  const { zettelSurprise } = await import("../../../zettelkasten/index.js");
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

export function registerSurpriseCommand(parent: Command): void {
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
}
