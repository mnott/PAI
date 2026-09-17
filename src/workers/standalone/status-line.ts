#!/usr/bin/env node

/**
 * Standalone worker status-line entry point.
 *
 * statusline-command.sh calls this (argv: <ITERM_SESSION_ID> <PWD>) on every
 * status refresh, so it must stay a plain node script with no CLI framework
 * and no daemon IPC: read the config, read the worker statuses, print one
 * line or nothing. Built to dist/worker-status-line.mjs by scripts/build-hooks.mjs
 * and symlinked to ~/.claude/worker-status-line.mjs.
 */

import { readWorkersSection } from "../config.js";
import { workersLogDir } from "../paths.js";
import { statusLineOutput } from "../viewer.js";

const term = process.argv[2] ?? process.env.ITERM_SESSION_ID ?? "";
const cwd = process.argv[3] ?? process.cwd();

try {
  const out = statusLineOutput(workersLogDir(readWorkersSection().workers), term, cwd);
  if (out) process.stdout.write(out + "\n");
} catch {
  // no workers section or a broken config: no line, never an error in the bar
}
