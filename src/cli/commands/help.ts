/**
 * pai help [area]
 *
 * Rich man-page viewer for the generated command docs under docs/commands/.
 * These pages are generated from the live Commander tree by
 * scripts/build-docs.mjs, so they never drift from the actual CLI.
 *
 *   pai help            → list all command areas (the index / apropos)
 *   pai help <area>     → print the man page for that area
 *
 * Falls back to `pai <area> --help` if a page is missing.
 */

import type { Command } from "commander";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { err, dim } from "../utils.js";

/**
 * Locate the docs/commands directory robustly, regardless of how the bundle is
 * chunked. Walks up from this module's location (and from argv[1]) looking for a
 * directory that contains docs/commands.
 */
function findDocsDir(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* ignore */
  }
  if (process.argv[1]) candidates.push(dirname(process.argv[1]));

  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      const probe = join(dir, "docs", "commands");
      if (existsSync(probe)) return probe;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Light terminal styling for the generated markdown — enough to read like a man
 * page without a full markdown renderer. Headings bold, table rules + fences
 * dimmed, blockquotes dimmed.
 */
function inlineBold(s: string): string {
  return s
    .replace(/\\\|/g, "|")
    .replace(/\*\*([^*]+)\*\*/g, (_m, t) => chalk.bold(t));
}

function renderMarkdown(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    // Drop the generator's HTML comment header.
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    // Code fences: suppress the ``` markers, colourise the body.
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(chalk.cyan(line));
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      out.push(chalk.bold(line.replace(/^#{1,6}\s/, "")));
      continue;
    }
    if (/^>\s?/.test(line)) {
      out.push(dim(line.replace(/^>\s?/, "")));
      continue;
    }
    // Markdown table rule rows.
    if (/^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?$/.test(line)) {
      out.push(dim(line));
      continue;
    }
    out.push(inlineBold(line));
  }
  // Collapse leading blank lines.
  while (out.length > 0 && out[0].trim() === "") out.shift();
  return out.join("\n");
}

function listAreas(docsDir: string): string[] {
  return readdirSync(docsDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

export function registerHelpCommand(program: Command): void {
  program
    .command("help [area]")
    .description("Show the man page for a command area (pai help <area>), or list all areas")
    .option("--raw", "Print raw markdown without terminal styling")
    .action((area: string | undefined, opts: { raw?: boolean }) => {
      const docsDir = findDocsDir();

      if (!docsDir) {
        console.error(err("  Command docs not found."));
        console.error(dim("  Run `bun run build` to generate them, or use `pai <area> --help`."));
        process.exitCode = 1;
        return;
      }

      // No area → print the index.
      if (!area) {
        const indexPath = join(docsDir, "README.md");
        if (existsSync(indexPath)) {
          const md = readFileSync(indexPath, "utf8");
          console.log(opts.raw ? md : renderMarkdown(md));
        } else {
          console.log(chalk.bold("\nPAI command areas\n"));
          for (const a of listAreas(docsDir)) console.log(`  ${a}`);
          console.log(dim("\n  pai help <area>   show the man page for an area"));
        }
        return;
      }

      // Area → print its page, or fall back.
      const page = join(docsDir, `${area}.md`);
      if (existsSync(page)) {
        const md = readFileSync(page, "utf8");
        console.log(opts.raw ? md : renderMarkdown(md));
        return;
      }

      console.error(err(`  No man page for "${area}".`));
      const areas = listAreas(docsDir);
      const near = areas.filter((a) => a.includes(area) || area.includes(a));
      if (near.length > 0) {
        console.error(dim(`  Did you mean: ${near.join(", ")}?`));
      } else {
        console.error(dim(`  Available: ${areas.join(", ")}`));
      }
      console.error(dim(`  Or try: pai ${area} --help`));
      process.exitCode = 1;
    });
}
