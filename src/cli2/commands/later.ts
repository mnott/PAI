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

/** Old `worker` subcommands not ported yet (the ported ones live in worker-config.ts). */
export const WORKER_LATER: CommandDef[] = [
  later("run", "Run a task on a worker", "worker run"), // later: worker run
  later("ps", "Workers running now", "worker ps"), // later: worker ps
  later("errors", "Recent worker tool errors", "worker errors"), // later: worker errors
  later("pending", "Finished workers not yet merged", "worker pending"), // later: worker pending
  later("follow", "Follow workers live", "worker follow"), // later: worker follow
  later("replay", "Replay a finished worker", "worker replay"), // later: worker replay
  later("watch", "Watch workers", "worker watch"), // later: worker watch
  later("pane", "Open or check a worker pane", "worker pane"), // later: worker pane
  later("log", "Worker log", "worker log"), // later: worker log
  later("say", "Send a message to a worker", "worker say"), // later: worker say
  later("goal", "Relabel a worker", "worker goal"), // later: worker goal
  later("handoff", "Hand a task up from inside a worker", "worker handoff"), // later: worker handoff
  later("merge", "Merge a worker's branch", "worker merge"), // later: worker merge
  later("verify", "Verify a worker's changes", "worker verify"), // later: worker verify
  later("wait-on", "Wait for a process", "worker wait-on"), // later: worker wait-on
  later("wait", "Wait for workers", "worker wait"), // later: worker wait
  later("discard", "Discard a worker's branch", "worker discard"), // later: worker discard
  later("gc", "Archive finished workers", "worker gc"), // later: worker gc
  later("kill", "Stop a worker", "worker kill"), // later: worker kill
  later("resume", "Continue a finished worker", "worker resume"), // later: worker resume
  later("status-line", "One-line worker summary for a status bar", "worker status-line"), // later: worker status-line
  later("model", "Provider model settings", "worker model"), // later: worker model
  later("capability", "Capability preferences", "worker capability"), // later: worker capability
];

export const LATER_GROUPS: Pick<GroupDef, "id" | "commands">[] = [
  {
    id: "workers",
    commands: [
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
