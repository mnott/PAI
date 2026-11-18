#!/usr/bin/env node

/**
 * code-graph-dirty.ts — PostToolUse (Edit|Write|MultiEdit|NotebookEdit)
 *
 * Appends the edited file's path to the repo's small dirty list. Nothing is
 * parsed or indexed here: the next code-graph query re-reads the listed files first.
 */

import { dirname } from "node:path";
import { resolveRoot } from "../../../codegraph/api.js";
import { markDirty } from "../../../codegraph/session.js";
import { readHookInput } from "../lib/read-stdin.js";

async function main() {
  const input = await readHookInput<{ cwd?: string; tool_input?: { file_path?: string; notebook_path?: string } }>();
  const file = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (!file || !file.startsWith("/")) return;
  markDirty(resolveRoot(dirname(file)), file);
}

main().then(() => process.exit(0), () => process.exit(0));
