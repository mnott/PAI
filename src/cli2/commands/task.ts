/**
 * `pai task` (also `pai tasks`): front end for the task commands.
 * Behaviour lives in src/cli2/impl/task.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { legacyRunner } from "../lib/legacy.js";
import { registerTaskCommands } from "../impl/task.js";

const L = legacyRunner("task", registerTaskCommands);

export const taskSubcommands: CommandDef[] = [
L({
  name: "projects",
  summary: "Show which projects can receive tasks, and create missing ones",
  description: "Show which projects can receive tasks, and create missing ones.\n\nShow which sessions can be given work from the tracker, and create the missing projects",
  args: [{ name: "MORE", summary: "More values for the list option above", variadic: true }],
  options: [{ name: "create", type: "string", value: "NAMES", summary: "Create tracker projects for these session names (several values allowed)" }, { name: "create-all", type: "boolean", summary: "Create a project for every session that has none" }],
  examples: ["pai task projects","pai task projects --create-all"],
  seeAlso: ["pai task list"],
}),
L({
  name: "list",
  summary: "List open tasks",
  description: "List open tasks.\n\nList open tasks on the bus",
  options: [{ name: "owner", type: "string", value: "PROJECT", summary: "Only tasks owned by this PAI project" }, { name: "due", type: "string", value: "DATE", summary: "Only tasks due on or before this ISO date" }, { name: "today", type: "boolean", summary: "Shorthand for --due <today>" }, { name: "routed", type: "boolean", summary: "Hide tasks with no resolved owner" }, { name: "limit", type: "string", value: "N", summary: "Maximum tasks to show" }],
  examples: ["pai task list","pai task list --today --owner my-app"],
  seeAlso: ["pai task add","pai task projects"],
}),
L({
  name: "add",
  summary: "Add a task to the list",
  description: "Add a task to the list.",
  args: [{ name: "TITLE", summary: "What the task is, in a few words", required: true }],
  options: [{ name: "owner", type: "string", value: "PROJECT", summary: "PAI project that owns this (adds a pai: label)" }, { name: "body", type: "string", value: "TEXT", summary: "Full procedure and reasoning — not just a restatement of the title" }, { name: "due", type: "string", value: "WHEN", summary: "Due date: ISO, natural language, or a recurrence (\"every monday at 9\")" }, { name: "priority", type: "string", value: "P", summary: "p1 (highest) … p4 (default)" }, { name: "url", type: "string", value: "URL", summary: "Reference — prefer a hook:// URL over a file path" }, { name: "into", type: "string", value: "SUB_PROJECT", summary: "File into this sub-project under the bus root, creating it if absent" }],
  examples: ["pai task add \"Fix the login bug\"","pai task add \"Write release notes\" --owner my-app --due tomorrow"],
  seeAlso: ["pai task dispatch","pai task list"],
}),
L({
  name: "dispatch",
  summary: "Hand open tasks to the sessions that own them",
  description: "Hand open tasks to the sessions that own them.\n\nHand open tasks to the PAI sessions that own them",
  options: [{ name: "owner", type: "string", value: "PROJECT", summary: "Only dispatch tasks for this project" }, { name: "today", type: "boolean", summary: "Only tasks due today or overdue" }, { name: "dry-run", type: "boolean", summary: "Report what would happen without contacting any session" }, { name: "no-spawn", type: "boolean", summary: "Never launch a session; skip owners that are not running" }],
  examples: ["pai task dispatch --dry-run","pai task dispatch --owner my-app --no-spawn"],
  seeAlso: ["pai task poll","pai task add"],
}),
L({
  name: "poll",
  summary: "Run one scheduler tick: dispatch what is due and report",
  description: "Run one scheduler tick: dispatch what is due and report.\n\nOne scheduler tick: dispatch what is due, check what is running, report",
  options: [{ name: "dry-run", type: "boolean", summary: "Show what would happen without touching anything" }],
  examples: ["pai task poll --dry-run","pai task poll"],
  seeAlso: ["pai task schedule","pai task dispatch"],
}),
{
  name: "schedule",
  summary: "Install, remove or check the timer that runs the scheduler",
  description: "Install, remove or check the timer that runs the scheduler.\n\nInstall, remove or inspect the launchd agent that ticks the scheduler",
  examples: ["pai task schedule status","pai task schedule install --interval 900"],
  seeAlso: ["pai task config","pai task poll"],
  subcommands: [L({
  name: "install",
  summary: "Install the timer (default: every 15 minutes)",
  description: "Install the timer (default: every 15 minutes).\n\nInstall the scheduler tick (default: every 15 minutes)",
  options: [{ name: "interval", type: "string", value: "SECS", summary: "Seconds between ticks" }],
  examples: ["pai task schedule install","pai task schedule install --interval 600"],
  seeAlso: ["pai task schedule uninstall"],
}),
L({
  name: "uninstall",
  summary: "Remove the timer",
  description: "Remove the timer.\n\nRemove the scheduler agent",
  examples: ["pai task schedule uninstall","pai task schedule status"],
  seeAlso: ["pai task schedule status","pai task schedule install"],
}),
L({
  name: "status",
  summary: "Show whether the timer is installed and running",
  description: "Show whether the timer is installed and running.\n\nShow whether the scheduler agent is installed and loaded",
  examples: ["pai task schedule status","pai task schedule status"],
  seeAlso: ["pai task schedule uninstall"],
})],
  run: undefined,
},
L({
  name: "config",
  summary: "Show or change task settings",
  description: "Show or change task settings.\n\nView or change task bus settings without running the full setup wizard",
  options: [{ name: "token", type: "boolean", summary: "Prompt for the Todoist API token (input is hidden)" }, { name: "from-env", type: "boolean", summary: "Adopt the token from TODOIST_API_KEY in the environment" }, { name: "project", type: "string", value: "ID", summary: "Tracker project ID that roots the bus (an ID, never a name)" }, { name: "findings", type: "string", value: "ID", summary: "Section ID for the findings inbox" }, { name: "timeout", type: "string", value: "SECS", summary: "Seconds a single dispatch may take" }, { name: "auto-dispatch", type: "string", value: "BOOL", summary: "Hand tasks to owning sessions automatically (true/false)" }, { name: "disable", type: "boolean", summary: "Turn the task bus off without discarding its settings" }],
  examples: ["pai task config","pai task config --auto-dispatch true"],
  seeAlso: ["pai task archive","pai task schedule"],
}),
L({
  name: "archive",
  summary: "Save a task's discussion into the project notes",
  description: "Save a task's discussion into the project notes.\n\nSave a task's discussion into the owning project's notes, without completing it",
  args: [{ name: "ID", summary: "Task id (see: pai task list)", required: true }],
  options: [{ name: "quiet", type: "boolean", summary: "Print nothing (for hook and webhook callers)" }, { name: "no-notify", type: "boolean", summary: "Do not tell the owning session where the file landed" }],
  examples: ["pai task archive 123456","pai task archive 123456 --quiet"],
  seeAlso: ["pai task done","pai task config"],
}),
L({
  name: "done",
  summary: "Mark a task complete",
  description: "Mark a task complete.\n\nMark a task complete on the tracker, keeping its discussion",
  args: [{ name: "ID", summary: "Task id (see: pai task list)", required: true }],
  options: [{ name: "no-archive", type: "boolean", summary: "Complete without saving the comment thread" }],
  examples: ["pai task done 123456","pai task done 123456 --no-archive"],
  seeAlso: ["pai task archive"],
}),
];

export const taskCommand: CommandDef = {
  name: "task",
  summary: "Cross-session task list: list, add, dispatch, done",
  description: "Cross-session task list: list, add, dispatch, done.",
  examples: ["pai task list","pai task add \"Fix the login bug\" --owner my-app"],
  subcommands: taskSubcommands,
};

export const taskAliasCommand: CommandDef = {
  name: "tasks",
  summary: "Same as task",
  description: "Same as `pai task`: Cross-session task list: list, add, dispatch, done.",
  examples: ["pai tasks list","pai tasks add \"Fix the login bug\" --owner my-app"],
  aliasOf: "task",
  subcommands: taskSubcommands,
};
