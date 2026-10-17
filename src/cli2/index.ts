#!/usr/bin/env node
/**
 * pai (rewrite) — entry point. Temporary bin name `pai2` while the old CLI in
 * src/cli is still `pai`. All behaviour lives in run.ts and the registry.
 */

import { dropItermBundleId } from "../utils/env.js";
import { drainStdio } from "./lib/exit.js";
import { GROUPS } from "./registry.js";
import { runCli } from "./run.js";

dropItermBundleId();
process.exitCode = await runCli(GROUPS, process.argv.slice(2));
await drainStdio();
