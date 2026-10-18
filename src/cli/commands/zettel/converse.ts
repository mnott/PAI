/** zettel converse: ask the vault a question and get a synthesis prompt. */

import chalk from "chalk";
import { warn, err, dim, bold, header } from "../../lib/utils.js";
import { getFedBackend, shortPath } from "./utils.js";
import { CliError } from "../../define.js";

export async function zettelConverseCmd(
  question: string,
  opts: { vaultProjectId?: string | number; depth?: number; limit?: number }
): Promise<number> {
  if (opts.vaultProjectId === undefined) {
    throw new CliError("--vault-project-id is required", "pai help zettel converse", 1);
  }

  const vaultProjectId = Number(opts.vaultProjectId);
  const depth = opts.depth ?? 2;
  const limit = opts.limit ?? 15;

  const { zettelConverse } = await import("../../../zettelkasten/index.js");
  const backend = await getFedBackend();

  console.log();
  console.log(header("  PAI Zettel Converse"));
  console.log(dim(`  Question: "${question}"`));
  process.stdout.write(dim("  Searching vault for relevant notes...\n"));

  const result = await zettelConverse(backend, { question, vaultProjectId, depth, limit });

  if (result.relevantNotes.length === 0) {
    console.log(warn("  No relevant notes found. Try rephrasing your question."));
    console.log();
    return 0;
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

  return 0;
}
