#!/usr/bin/env node
/**
 * PAI Daemon — Entry point
 *
 * Commands:
 *   serve   — Start the PAI daemon (foreground, managed by launchd in production)
 *   status  — Query daemon status via IPC
 *   index   — Trigger an immediate index run via IPC
 */

import { loadConfig, ensureConfigDir } from "./config.js";
import { serve } from "./daemon.js";
import { PaiClient } from "./ipc-client.js";
import { dropItermBundleId } from "../utils/env.js";

dropItermBundleId();

const USAGE = `Usage: pai-daemon <command>

PAI Daemon — background service for PAI Knowledge OS

Commands:
  serve    Start the PAI daemon in the foreground
  status   Query the running daemon status
  index    Trigger an immediate index run in the running daemon
`;

const cmd = process.argv[2];

if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(USAGE);
  process.exit(0);
}

if (cmd === "--version" || cmd === "-V") {
  console.log("0.1.0");
  process.exit(0);
}

if (cmd === "serve") {
  ensureConfigDir();
  const config = loadConfig();
  await serve(config);
} else if (cmd === "status") {
  const config = loadConfig();
  const client = new PaiClient(config.socketPath);

  try {
    const status = await client.status();
    console.log(JSON.stringify(status, null, 2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
} else if (cmd === "index") {
  const config = loadConfig();
  const client = new PaiClient(config.socketPath);

  try {
    await client.triggerIndex();
    console.log("Index triggered. Check daemon logs for progress.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
} else {
  console.error(`pai-daemon: unknown command "${cmd}"\n${USAGE}`);
  process.exit(2);
}