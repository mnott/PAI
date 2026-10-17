/**
 * Placeholders for every old command not yet ported. Each entry keeps the
 * old name (and its summary from src/cli/program.ts) so the port workers
 * have a checklist and `pai help more` shows the whole surface. Running one
 * says to use the old `pai`.
 */

import type { CommandDef, GroupDef } from "../define.js";

const later = (name: string, summary: string, oldCommand = name): CommandDef => ({
  name,
  summary,
  description: summary,
  examples: [`pai ${oldCommand}`],
  later: oldCommand,
});

export const SESSION_LATER: CommandDef[] = [
];

export const SESSION_SHORTCUTS_LATER: CommandDef[] = [
];

export const LATER_GROUPS: Pick<GroupDef, "id" | "commands">[] = [
  {
    id: "workers",
    commands: [
      later("worker", "Run subagents on other providers: run, ps, follow, merge, ..."), // later: worker
      later("router", "Request router: start, stop, status, run, stats"), // later: router
    ],
  },
  {
    id: "memory",
    commands: [
      later("project", "Registered projects: list, add, info, health, ..."), // later: projects / project
      later("projects", "Alias of project", "projects"), // later: projects
      later("memory", "Memory engine: index, search, status"), // later: memory
      later("registry", "Registry maintenance: scan, migrate, stats, rebuild"), // later: registry
      later("kg", "Temporal knowledge graph"), // later: kg
      later("zettel", "Zettelkasten intelligence"), // later: zettel
      later("observation", "Observation capture: list, search, stats"), // later: observation
      later("obsidian", "Obsidian vault sync"), // later: obsidian
      later("topic", "Topic shift detection"), // later: topic
      later("task", "Task bus: list, add, dispatch, done"), // later: task / tasks
      later("skill", "Skill telemetry"), // later: skill
      later("issue", "Claim and release forge issues"), // later: issue
      later("identity", "Who you are: self addresses and mail delivery"), // later: identity
      later("notify", "Notification config"), // later: notify
    ],
  },
  {
    id: "daemon",
    commands: [
      later("daemon", "Daemon: serve, status, restart, install, logs"), // later: daemon
      later("config", "PAI_HOME config: path, yaml, get, set, migrate"), // later: config
      later("mcp", "MCP server install and status"), // later: mcp
      later("db", "Database inspection and migration"), // later: db
      later("audit", "Token-waste and other audits"), // later: audit
    ],
  },
];
