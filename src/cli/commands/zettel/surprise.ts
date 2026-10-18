/** zettel surprise: find semantically similar but graph-distant notes. */

import chalk from "chalk";
import { warn, err, dim, bold, header } from "../../lib/utils.js";
import { getFedBackend, shortPath } from "./utils.js";
import { CliError } from "../../define.js";

export async function zettelSurpriseCmd(
  note: string,
  opts: { vaultProjectId?: string | number; limit?: number; minSimilarity?: number; minDistance?: number }
): Promise<number> {
  if (opts.vaultProjectId === undefined) {
    throw new CliError("--vault-project-id is required", "pai help zettel surprise", 1);
  }

  const vaultProjectId = Number(opts.vaultProjectId);
  const limit = opts.limit ?? 10;
  const minSimilarity = opts.minSimilarity ?? 0.3;
  const minGraphDistance = opts.minDistance ?? 3;

  const { zettelSurprise } = await import("../../../zettelkasten/index.js");
  const backend = await getFedBackend();

  console.log();
  console.log(header("  PAI Zettel Surprise"));
  console.log(dim(`  Reference note: ${note}`));
  process.stdout.write(dim("  Searching for surprising connections...\n"));

  const results = await zettelSurprise(backend, {
    referencePath: note,
    vaultProjectId,
    limit,
    minSimilarity,
    minGraphDistance,
  });

  if (results.length === 0) {
    console.log(warn("  No surprising connections found. Try lowering --min-similarity or --min-distance."));
    console.log();
    return 0;
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

  return 0;
}
