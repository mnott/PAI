#!/usr/bin/env node

/**
 * code-graph.ts — SessionStart hook
 *
 * Tells the session the code graph exists: one line when the repo is indexed;
 * when it is not, starts `pai code index` in the background (one at a time per
 * machine, background priority, skipped while frozen or on low battery) and
 * says so. Never blocks the session start and always exits 0.
 */

import { getStorageBackend } from "../../../storage/factory.js";
import { resolveRoot } from "../../../codegraph/api.js";
import { sessionGraphLine } from "../../../codegraph/session.js";
import { readHookInput } from "../lib/read-stdin.js";
import { isWorkerSession } from "../lib/worker-session.js";

async function main() {
  if (isWorkerSession()) return; // workers get the line in their system prompt
  const input = await readHookInput<{ cwd?: string }>();
  const line = await sessionGraphLine(await getStorageBackend(), resolveRoot(input?.cwd ?? process.cwd()));
  if (line) console.log(line);
}

main().then(() => process.exit(0), (e) => { if (process.env.PAI_DEBUG) console.error(e); process.exit(0); });
