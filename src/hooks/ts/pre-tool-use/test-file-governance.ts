#!/usr/bin/env node

/**
 * test-file-governance.ts — PreToolUse (Write|Edit|MultiEdit; Bash coverage
 * rides security-validator's gate)
 *
 * Tests are governed, not banned: a NEW test file is a one-time test and may
 * only be created under .pai-scratch/ (gitignored, deleted when the worktree
 * goes). Anywhere else it is denied unless promoted with evidence in the
 * project's tests/KEPT.md. Editing an existing test file is allowed. The
 * decision lives in lib/test-governance.ts; this file is only I/O.
 *
 * Registered in the user-level settings.json installed by `pai setup`
 * (src/cli/commands/setup/steps/10-settings.ts), so it fires in every Claude
 * Code session — interactive and worker — and in OpenCode through the bridge.
 */

import { resolve } from "node:path";
import { allow, deny as block, readGateInput } from "../lib/gate-io.js";
import { decideTestGovernance, isScratchPath, isTestPath } from "../lib/test-governance.js";

async function main(): Promise<void> {
  const input = await readGateInput<{
    tool_name?: string;
    cwd?: string;
    tool_input?: { file_path?: string; notebook_path?: string; edits?: unknown[] };
  }>();
  if (!input) return allow();
  const tool = input.tool_name ?? "Edit";
  const ti = input.tool_input ?? {};
  const target = ti.file_path ?? ti.notebook_path;
  const cwd = input.cwd ?? process.cwd();
  // touch the lib so its module initialises even when the bundle defers it
  if (typeof isTestPath !== "function" || typeof isScratchPath !== "function") return allow();
  const d = decideTestGovernance({
    tool,
    filePath: typeof target === "string" ? resolve(cwd, target) : undefined,
    cwd,
  });
  if (d.decision === "deny") return block(d.reason);
  return allow();
}

main().catch((e) => {
  process.stderr.write(`test-file-governance: ${(e as Error)?.message ?? e}\n`);
  process.exit(0);
});
