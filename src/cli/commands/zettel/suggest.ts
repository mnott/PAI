/** zettel suggest: suggest new wikilink connections for a note. */

import chalk from "chalk";
import { warn, err, dim, bold, header } from "../../lib/utils.js";
import { getFedBackend, shortPath } from "./utils.js";
import { CliError } from "../../define.js";

export async function zettelSuggestCmd(
  note: string,
  opts: { vaultProjectId?: string | number; limit?: number; excludeLinked?: boolean }
): Promise<number> {
  if (opts.vaultProjectId === undefined) {
    throw new CliError("--vault-project-id is required", "pai help zettel suggest", 1);
  }

  const vaultProjectId = Number(opts.vaultProjectId);
  const limit = opts.limit ?? 5;
  const excludeLinked = opts.excludeLinked !== true;

  const { zettelSuggest } = await import("../../../zettelkasten/index.js");
  const backend = await getFedBackend();

  console.log();
  console.log(header("  PAI Zettel Suggest"));
  console.log(dim(`  Note: ${note}`));
  process.stdout.write(dim("  Computing suggestions...\n"));

  const suggestions = await zettelSuggest(backend, {
    notePath: note,
    vaultProjectId,
    limit,
    excludeLinked,
  });

  if (suggestions.length === 0) {
    console.log(warn("  No suggestions found. The note may be well-connected already."));
    console.log();
    return 0;
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

  return 0;
}
