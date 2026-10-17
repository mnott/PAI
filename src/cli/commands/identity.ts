/**
 * `pai identity`: front end for the identity commands.
 * Behaviour lives in src/cli/impl/identity.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { identityShow, identityAdd, identityRemove, identitySetDelivery } from "../impl/identity.js";

export const identitySubcommands: CommandDef[] = [
{
  name: "show",
  summary: "Show your addresses and where mail is delivered",
  description: "Show your addresses and where mail is delivered.",
  examples: ["pai identity show","pai identity show"],
  seeAlso: ["pai identity add"],
  run: (ctx) => identityShow(),
},
{
  name: "add",
  summary: "Add an address that is yours",
  description: "Add an address that is yours.\n\nDeclare an address as your own (widens what can be sent unreviewed)",
  args: [{ name: "EMAIL", summary: "Email address", required: true }],
  examples: ["pai identity add me@example.com","pai identity show"],
  seeAlso: ["pai identity remove","pai identity show"],
  run: (ctx) => identityAdd(String(ctx.args.EMAIL)),
},
{
  name: "remove",
  summary: "Stop treating an address as yours",
  description: "Stop treating an address as yours.",
  args: [{ name: "EMAIL", summary: "Email address", required: true }],
  examples: ["pai identity remove me@example.com","pai identity show"],
  seeAlso: ["pai identity set-delivery","pai identity add"],
  run: (ctx) => identityRemove(String(ctx.args.EMAIL)),
},
{
  name: "set-delivery",
  summary: "Choose where digests and \"mail me\" messages go",
  description: "Choose where digests and \"mail me\" messages go.",
  args: [{ name: "EMAIL", summary: "Email address", required: true }],
  examples: ["pai identity set-delivery me@example.com","pai identity show"],
  seeAlso: ["pai identity remove"],
  run: (ctx) => identitySetDelivery(String(ctx.args.EMAIL)),
},
];

export const identityCommand: CommandDef = {
  name: "identity",
  summary: "Say who you are, so mail to you can be told from mail to others",
  description: "Say who you are, so mail to you can be told from mail to others.",
  examples: ["pai identity show","pai identity add me@example.com"],
  subcommands: identitySubcommands,
};
