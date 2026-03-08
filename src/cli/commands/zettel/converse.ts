/** zettel converse: ask the vault a question and get a synthesis prompt. */

import type { Command } from "commander";
import chalk from "chalk";
import { warn, err, dim, bold, header } from "../../utils.js";
import { getFedDb, shortPath } from "./utils.js";

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

  const { zettelConverse } = await import("../../../zettelkasten/index.js");
  const db = getFedDb();

  console.log();
  console.log(header("  PAI Zettel Converse"));
  console.log(dim(`  Question: "${question}"`));
  process.stdout.write(dim("  Searching vault for relevant notes...\n"));

  const result = await zettelConverse(db, { question, vaultProjectId, depth, limit });

  if (result.relevantNotes.length === 0) {
    console.log(warn("  No relevant notes found. Try rephrasing your question."));
    console.log();
    return;
  }

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

  console.log(bold("  Synthesis prompt (paste into your AI):"));
  console.log();
  const promptLines = result.synthesisPrompt.split("\n");
  for (const line of promptLines) {
    console.log(`  ${dim(line)}`);
  }
  console.log();
}

export function registerConverseCommand(parent: Command): void {
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
}
