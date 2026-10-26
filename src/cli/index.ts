#!/usr/bin/env node
/**
 * pai — entry point.
 *
 * The entry settles on every path: it awaits one promise (runCli), turns
 * Ctrl-C into a quiet exit 130 with the cursor restored, and ends with an
 * explicit process.exit. A command left pending when a prompt is cancelled would let the event loop
 * empty and Node print "unsettled top-level await".
 */

import { dropItermBundleId } from "../utils/env.js";
import { drainStdio } from "./lib/exit.js";
import { rootCommand } from "./commands/root.js";
import { GROUPS } from "./registry.js";
import { defaultIo, runCli } from "./run.js";

dropItermBundleId();

const SHOW_CURSOR = "\u001b[?25h";
const quit = (code: number): never => {
  if (process.stdout.isTTY) process.stdout.write(SHOW_CURSOR);
  process.exit(code);
};
// `pai worker ...` and `pai bench ...` install their own handlers (a run writes its final status; bench kills its script group first).
if (process.argv[2] !== "worker" && process.argv[2] !== "bench") {
  process.on("SIGINT", () => quit(130));
  process.on("SIGTERM", () => quit(143));
}

let code = 1;
try {
  code = await runCli(GROUPS, process.argv.slice(2), defaultIo(), rootCommand);
} catch (e) {
  process.stderr.write(`pai: unexpected failure: ${e instanceof Error ? e.message : String(e)}\nNext: re-run with PAI_DEBUG=1 for details.\n`);
  if (process.env.PAI_DEBUG && e instanceof Error) process.stderr.write((e.stack ?? "") + "\n");
}
await drainStdio();
quit(code);
