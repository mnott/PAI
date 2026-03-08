/** zettel suggest: suggest new wikilink connections for a note. */

import type { Command } from "commander";
import chalk from "chalk";
import { warn, err, dim, bold, header } from "../../utils.js";
import { getFedDb, shortPath } from "./utils.js";

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

  const { zettelSuggest } = await import("../../../zettelkasten/index.js");
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

export function registerSuggestCommand(parent: Command): void {
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
}
