/**
 * `pai notify`: front end for the notify commands.
 * Behaviour lives in src/cli2/impl/notify.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { legacyRunner } from "../lib/legacy.js";
import { registerNotifyCommands } from "../impl/notify.js";

const L = legacyRunner("notify", registerNotifyCommands);

export const notifySubcommands: CommandDef[] = [
L({
  name: "status",
  summary: "Show the notification mode and active channels",
  description: "Show the notification mode and active channels.\n\nShow current notification mode and active channels",
  examples: ["pai notify status","pai notify status"],
  seeAlso: ["pai notify get"],
}),
L({
  name: "get",
  summary: "Same as status",
  description: "Same as status.\n\nShow current notification config (alias for status)",
  examples: ["pai notify get","pai notify status"],
  seeAlso: ["pai notify set","pai notify status"],
}),
L({
  name: "set",
  summary: "Change the notification mode or channels",
  description: "Change the notification mode or channels.\n\nUpdate notification mode or channel configuration",
  args: [{ name: "MORE", summary: "More values for the list option above", variadic: true }],
  options: [{ name: "mode", type: "string", value: "MODE", summary: "Notification mode: auto | voice | whatsapp | ntfy | macos | cli | off" }, { name: "enable", type: "string", value: "CHANNEL", summary: "Enable one or more channels (several values allowed)" }, { name: "disable", type: "string", value: "CHANNEL", summary: "Disable one or more channels (several values allowed)" }, { name: "ntfy-url", type: "string", value: "URL", summary: "Set the ntfy.sh topic URL" }, { name: "ntfy-priority", type: "string", value: "LEVEL", summary: "Set ntfy priority: min | low | default | high | urgent" }, { name: "whatsapp-recipient", type: "string", value: "CONTACT", summary: "Set WhatsApp recipient" }],
  examples: ["pai notify set --mode auto","pai notify set --enable ntfy --disable whatsapp"],
  seeAlso: ["pai notify test","pai notify get"],
}),
L({
  name: "test",
  summary: "Send a test notification",
  description: "Send a test notification.\n\nSend a test notification through configured channels",
  options: [{ name: "event", type: "string", value: "EVENT", summary: "Event type to test: error | progress | completion | info | debug" }],
  examples: ["pai notify test","pai notify test --event error"],
  seeAlso: ["pai notify send","pai notify set"],
}),
L({
  name: "send",
  summary: "Send a notification with an event type and message",
  description: "Send a notification with an event type and message.\n\nSend a notification with an explicit event type and message",
  args: [{ name: "EVENT", summary: "Event type, e.g. info or error", required: true }, { name: "MESSAGE", summary: "Message text, in quotes", required: true }],
  options: [{ name: "title", type: "string", value: "TITLE", summary: "Optional notification title" }],
  examples: ["pai notify send info \"Build finished\"","pai notify send error \"Build failed\" --title CI"],
  seeAlso: ["pai notify test"],
}),
];

export const notifyCommand: CommandDef = {
  name: "notify",
  summary: "Notification settings: status, set, test, send",
  description: "Notification settings: status, set, test, send.",
  examples: ["pai notify status","pai notify test"],
  subcommands: notifySubcommands,
};
