/**
 * pai topic <sub-command>
 *
 * check <context>  — Check whether context text has drifted to a different project
 *
 * Communicates with the running daemon via IPC.
 * The daemon uses BM25 keyword search to match context against indexed memory.
 *
 * Examples:
 *   pai topic check "working on authentication and JWT tokens"
 *   pai topic check "fixing the React component" --current myapp
 *   pai topic check "database schema migration" --threshold 0.7
 */

import type { Command } from "commander";
import { ok, warn, err, dim, bold, header } from "../utils.js";
import { loadConfig } from "../../daemon/config.js";
import { PaiClient } from "../../daemon/ipc-client.js";
import type { TopicCheckResult } from "../../topics/detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): PaiClient {
  const config = loadConfig();
  return new PaiClient(config.socketPath);
}

function confidenceBar(confidence: number, width = 20): string {
  const filled = Math.round(confidence * width);
  const empty = width - filled;
  return "[" + "=".repeat(filled) + " ".repeat(empty) + "]";
}

function printTopicResult(result: TopicCheckResult): void {
  console.log();
  console.log(header("  PAI Topic Check"));
  console.log();

  console.log(`  ${bold("Current project:")}    ${result.currentProject ?? dim("(none)")}`);
  console.log(`  ${bold("Suggested project:")}  ${result.suggestedProject ?? dim("(none)")}`);
  console.log(
    `  ${bold("Confidence:")}         ${confidenceBar(result.confidence)} ${(result.confidence * 100).toFixed(1)}%`
  );
  console.log(`  ${bold("Chunks scored:")}      ${result.chunkCount}`);

  if (result.topProjects.length > 0) {
    console.log();
    console.log(`  ${bold("Top matches:")}`);
    for (const p of result.topProjects) {
      const bar = confidenceBar(p.score, 15);
      const marker = p.slug === result.currentProject ? dim(" (current)") : "";
      console.log(`    ${p.slug.padEnd(30)} ${bar} ${(p.score * 100).toFixed(1)}%${marker}`);
    }
  }

  console.log();

  if (result.shifted) {
    console.log(
      warn("  TOPIC SHIFT DETECTED") +
      dim(` — conversation appears to be about "${result.suggestedProject}", not "${result.currentProject}"`)
    );
    console.log();
  } else if (result.suggestedProject && result.suggestedProject === result.currentProject) {
    console.log(ok("  No shift detected") + dim(" — context matches current project"));
    console.log();
  } else if (!result.currentProject) {
    if (result.suggestedProject) {
      console.log(
        ok("  Best matching project: ") + bold(result.suggestedProject) +
        dim(` (confidence: ${(result.confidence * 100).toFixed(0)}%)`)
      );
    } else {
      console.log(dim("  No matching project found in memory index."));
    }
    console.log();
  } else {
    console.log(
      dim(`  No shift detected (top match "${result.suggestedProject}" has confidence ${(result.confidence * 100).toFixed(0)}% — below threshold)`)
    );
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdCheck(
  context: string,
  opts: {
    current?: string;
    threshold?: string;
    json?: boolean;
  }
): Promise<void> {
  const client = makeClient();

  const threshold = opts.threshold ? parseFloat(opts.threshold) : undefined;

  if (threshold !== undefined && (isNaN(threshold) || threshold < 0 || threshold > 1)) {
    console.error(err("  --threshold must be a number between 0 and 1"));
    process.exit(1);
  }

  try {
    const result = await client.topicCheck({
      context,
      currentProject: opts.current,
      threshold,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    printTopicResult(result);

    // Exit with code 1 if a shift was detected (useful for scripting / hooks)
    if (result.shifted) {
      process.exit(1);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log();
    console.log(warn("  Cannot reach PAI daemon."));
    console.log(dim(`  ${msg}`));
    console.log(dim("  Start it with: pai daemon serve"));
    console.log();
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerTopicCommands(topicCmd: Command): void {
  // pai topic check <context>
  topicCmd
    .command("check <context>")
    .description(
      "Check whether context text has drifted to a different project.\n" +
      'Example: pai topic check "working on JWT authentication"\n' +
      "Exit code 1 if a shift is detected (useful for hooks)."
    )
    .option(
      "--current <slug>",
      "The project this session is currently routed to"
    )
    .option(
      "--threshold <n>",
      "Confidence threshold [0-1] to declare a shift (default: 0.6)"
    )
    .option("--json", "Output raw JSON result")
    .action(
      async (
        context: string,
        opts: { current?: string; threshold?: string; json?: boolean }
      ) => {
        await cmdCheck(context, opts);
      }
    );
}
