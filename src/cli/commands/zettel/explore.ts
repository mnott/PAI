/** zettel explore: follow link chains from a starting note. */

import type { Command } from "commander";
import chalk from "chalk";
import { ok, warn, err, dim, bold, header } from "../../utils.js";
import { getFedDb, shortPath } from "./utils.js";

async function cmdExplore(
  note: string,
  opts: { depth?: string; direction?: string; mode?: string }
): Promise<void> {
  const depth = parseInt(opts.depth ?? "3", 10);
  const direction = (opts.direction ?? "both") as "forward" | "backward" | "both";
  const mode = (opts.mode ?? "all") as "sequential" | "associative" | "all";

  const { zettelExplore } = await import("../../../zettelkasten/index.js");
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

  console.log(`  ${chalk.cyan("●")} ${bold(shortPath(result.root))}  ${dim("(root)")}`);

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

export function registerExploreCommand(parent: Command): void {
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
}
