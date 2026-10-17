/**
 * `pai topic`: front end for the topic commands.
 * Behaviour lives in src/cli2/impl/topic.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { legacyRunner } from "../lib/legacy.js";
import { registerTopicCommands } from "../impl/topic.js";

const L = legacyRunner("topic", registerTopicCommands);

export const topicSubcommands: CommandDef[] = [
L({
  name: "check",
  summary: "Check whether a text belongs to a different project than the current one",
  description: "Check whether a text belongs to a different project than the current one.\n\nCheck whether context text has drifted to a different project.\nExample: pai topic check \"working on JWT authentication\"\nExit code 1 if a shift is detected (useful for hooks).",
  args: [{ name: "CONTEXT", summary: "The text to check, in quotes", required: true }],
  options: [{ name: "current", type: "string", value: "SLUG", summary: "The project this session is currently routed to" }, { name: "threshold", type: "string", value: "N", summary: "Confidence threshold [0-1] to declare a shift (default: 0.6)" }, { name: "json", type: "boolean", summary: "Output raw JSON result" }],
  examples: ["pai topic check \"fix the login page\"","pai topic check \"fix the login page\" --current my-app --json"],
}),
];

export const topicCommand: CommandDef = {
  name: "topic",
  summary: "Detect when a conversation moved to another project",
  description: "Detect when a conversation moved to another project.",
  examples: ["pai topic check \"fix the login page\"","pai topic check \"fix the login page\" --current my-app"],
  subcommands: topicSubcommands,
};
