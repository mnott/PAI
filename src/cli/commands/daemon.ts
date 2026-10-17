/**
 * `pai daemon`: front end for the daemon commands.
 * Behaviour lives in src/cli/impl/daemon.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { legacyRunner } from "../lib/legacy.js";
import { registerDaemonCommands } from "../impl/daemon.js";

const L = legacyRunner("daemon", registerDaemonCommands);

export const daemonSubcommands: CommandDef[] = [
L({
  name: "serve",
  summary: "Run the daemon in the foreground",
  description: "Run the daemon in the foreground.\n\nStart the PAI daemon in the foreground",
  examples: ["pai daemon serve","pai daemon status"],
  seeAlso: ["pai daemon migrate"],
}),
L({
  name: "migrate",
  summary: "Copy federation data from SQLite to PostgreSQL",
  description: "Copy federation data from SQLite to PostgreSQL.",
  options: [{ name: "connection-string", type: "string", value: "URL", summary: "Postgres connection string (default: from config or postgresql://pai:pai@localhost:5432/pai)" }],
  examples: ["pai daemon migrate --connection-string postgres://localhost/pai","pai daemon status"],
  seeAlso: ["pai daemon status","pai daemon serve"],
}),
L({
  name: "status",
  summary: "Show whether the daemon is running",
  description: "Show whether the daemon is running.",
  examples: ["pai daemon status","pai daemon logs"],
  seeAlso: ["pai daemon restart","pai daemon migrate"],
}),
L({
  name: "restart",
  summary: "Restart the daemon",
  description: "Restart the daemon.\n\nRestart the running daemon (launchd on macOS, systemd on Linux)",
  examples: ["pai daemon restart","pai daemon status"],
  seeAlso: ["pai daemon install","pai daemon status"],
}),
L({
  name: "install",
  summary: "Install the daemon as a login service",
  description: "Install the daemon as a login service.\n\nInstall daemon as a service (launchd/systemd) and update ~/.claude.json to use the shim",
  examples: ["pai daemon install","pai daemon status"],
  seeAlso: ["pai daemon uninstall","pai daemon restart"],
}),
L({
  name: "uninstall",
  summary: "Remove the daemon service",
  description: "Remove the daemon service.\n\nRemove the daemon service (launchd/systemd) and revert to direct MCP",
  examples: ["pai daemon uninstall","pai daemon status"],
  seeAlso: ["pai daemon keepalive","pai daemon install"],
}),
L({
  name: "keepalive",
  summary: "Show session keepalive settings and recent activity",
  description: "Show session keepalive settings and recent activity.\n\nShow interactive-session cache keepalive config, per-session beat counters, and recent ledger lines",
  examples: ["pai daemon keepalive","pai daemon status"],
  seeAlso: ["pai daemon logs","pai daemon uninstall"],
}),
L({
  name: "logs",
  summary: "Show the end of the daemon log",
  description: "Show the end of the daemon log.\n\nTail the daemon log (/tmp/pai-daemon.log)",
  options: [{ name: "lines", short: "n", type: "string", value: "N", summary: "Number of lines to show" }, { name: "follow", short: "f", type: "boolean", summary: "Follow log output (like tail -f)" }],
  examples: ["pai daemon logs","pai daemon logs --lines 200 --follow"],
  seeAlso: ["pai daemon keepalive"],
}),
];

export const daemonCommand: CommandDef = {
  name: "daemon",
  summary: "The background service: status, restart, logs",
  description: "The background service: status, restart, logs.",
  examples: ["pai daemon status","pai daemon logs -n 50"],
  subcommands: daemonSubcommands,
};
