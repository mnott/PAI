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
  later("autosave", "Autosave the live session (called by the autosave hook)", "session autosave"), // later: session autosave
  later("recent", "Recent sessions with the live ones first", "session recent"), // later: session recent
  later("active", "Sessions active right now", "session active"), // later: session active
  later("handover", "Write or show a session handover", "session handover"), // later: session handover
  later("checkpoint", "Save a checkpoint message", "session checkpoint"), // later: session checkpoint
  later("info", "Details of one session note", "session info"), // later: session info
  later("slug", "Generate a slug for a session note", "session slug"), // later: session slug
  later("tag", "Tag a session note", "session tag"), // later: session tag
  later("route", "Move a session note to another project", "session route"), // later: session route
  later("auto-route", "Route session notes automatically", "session auto-route"), // later: session auto-route
  later("restore", "Restore a session transcript", "session restore"), // later: session restore
  later("cleanup", "Clean up stale sessions", "session cleanup"), // later: session cleanup
  later("goto", "Go to a session by name (use `open`)", "session goto"), // later: session goto
  later("pause", "Save a checkpoint for the current session", "session pause"), // later: session pause
];

export const SESSION_SHORTCUTS_LATER: CommandDef[] = [
  later("pause", "Save state before leaving a session"), // later: pause
  later("end", "Finalize the current session"), // later: end
  later("resume", "Resume a session by name (use `open`)"), // later: resume
  later("clear-names", "Wipe the corrupt iTerm tab-name store"), // later: clear-names
  later("sessions", "Old session listing (use `ls`)"), // later: sessions
];

export const LATER_GROUPS: Pick<GroupDef, "id" | "commands">[] = [
  {
    id: "workers",
    commands: [
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
      later("find", "Search prompt history for sessions"), // later: find
      later("notes", "Markdown session notes"), // later: notes / list
      later("cd", "Go to a project directory (shell wrapper)"), // later: cd
    ],
  },
  {
    id: "daemon",
    commands: [
      later("daemon", "Daemon: serve, status, restart, install, logs"), // later: daemon
      later("setup", "First-time setup"), // later: setup
      later("update", "Update PAI"), // later: update
      later("config", "PAI_HOME config: path, yaml, get, set, migrate"), // later: config
      later("mcp", "MCP server install and status"), // later: mcp
      later("hooks-db", "Registry updates for the shell hooks"), // later: hooks-db
      later("backup", "Back up PAI data"), // later: backup
      later("restore", "Restore a backup"), // later: restore
      later("db", "Database inspection and migration"), // later: db
      later("audit", "Token-waste and other audits"), // later: audit
      later("shell-init", "Shell integration code"), // later: shell-init
      later("launch", "Start the harness on a provider (use `new` / `open`)"), // later: launch
    ],
  },
];
