#!/usr/bin/env node
/**
 * PAI Daemon — Entry point
 *
 * Commands:
 *   serve   — Start the PAI daemon (foreground, managed by launchd in production)
 *   status  — Query daemon status via IPC
 *   index   — Trigger an immediate index run via IPC
 */

import { Command } from "commander";
import { loadConfig, ensureConfigDir } from "./config.js";
import { serve } from "./daemon.js";
import { PaiClient } from "./ipc-client.js";

const program = new Command();

program
  .name("pai-daemon")
  .description("PAI Daemon — background service for PAI Knowledge OS")
  .version("0.1.0");

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

program
  .command("serve")
  .description("Start the PAI daemon in the foreground")
  .action(async () => {
    ensureConfigDir();
    const config = loadConfig();
    await serve(config);
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description("Query the running daemon status")
  .action(async () => {
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
  });

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

program
  .command("index")
  .description("Trigger an immediate index run in the running daemon")
  .action(async () => {
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
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);

if (process.argv.length <= 2) {
  program.help();
}
