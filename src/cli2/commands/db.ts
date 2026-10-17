/**
 * `pai db`: front end for the db commands.
 * Behaviour lives in src/cli2/impl/db.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { legacyRunner } from "../lib/legacy.js";
import { registerDbCommands } from "../impl/db.js";

const L = legacyRunner("db", registerDbCommands);

export const dbSubcommands: CommandDef[] = [
L({
  name: "query",
  summary: "Run a SQL query",
  description: "Run a SQL query.\n\nRun a SQL query against the selected database",
  args: [{ name: "SQL", summary: "The SQL query, in quotes", required: true }],
  options: [{ name: "db", type: "string", value: "TARGET", summary: "Database target: sqlite (default) or postgres" }, { name: "json", type: "boolean", summary: "Output results as JSON array" }],
  examples: ["pai db query \"SELECT count(*) FROM projects\"","pai db query \"SELECT slug FROM projects LIMIT 5\" --json"],
  seeAlso: ["pai db tables"],
}),
L({
  name: "tables",
  summary: "List the tables",
  description: "List the tables.\n\nList all tables in the selected database",
  options: [{ name: "db", type: "string", value: "TARGET", summary: "Database target: sqlite (default) or postgres" }, { name: "json", type: "boolean", summary: "Output as JSON array" }],
  examples: ["pai db tables","pai db tables --json"],
  seeAlso: ["pai db schema","pai db query"],
}),
L({
  name: "schema",
  summary: "Show the columns of a table",
  description: "Show the columns of a table.",
  args: [{ name: "TABLE", summary: "Table name (see: pai db tables)", required: true }],
  options: [{ name: "db", type: "string", value: "TARGET", summary: "Database target: sqlite (default) or postgres" }, { name: "json", type: "boolean", summary: "Output as JSON array" }],
  examples: ["pai db schema projects","pai db schema projects --json"],
  seeAlso: ["pai db migrate-to-postgres","pai db tables"],
}),
L({
  name: "migrate-to-postgres",
  summary: "One-time copy of the data from SQLite to PostgreSQL",
  description: "One-time copy of the data from SQLite to PostgreSQL.\n\nOne-shot migration of kg_entities, registry tables, and memory/vault rows from SQLite to Postgres",
  options: [{ name: "dry-run", type: "boolean", summary: "Preflight + counts only — no writes, no pg_dump" }, { name: "skip-dump", type: "boolean", summary: "Skip the pg_dump rollback artefact (tests only)" }, { name: "allow-running", type: "boolean", summary: "Skip the daemon-not-running refusal (tests only)" }],
  examples: ["pai db migrate-to-postgres --dry-run","pai db migrate-to-postgres --skip-dump"],
  seeAlso: ["pai db schema"],
}),
];

export const dbCommand: CommandDef = {
  name: "db",
  summary: "Look into the PAI database (read only)",
  description: "Look into the PAI database (read only).",
  examples: ["pai db tables","pai db schema registry_projects"],
  subcommands: dbSubcommands,
};
