/**
 * `pai issue`: front end for the issue commands.
 * Behaviour lives in src/cli/impl/issue.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { issueClaimCmd, issueReleaseCmd, issueClaimsCmd, issueStaleCmd } from "../impl/issue.js";

export const issueSubcommands: CommandDef[] = [
{
  name: "claim",
  summary: "Mark issue N as yours (assignee and in-progress label)",
  description: "Mark issue N as yours (assignee and in-progress label).\n\nClaim forge issue <n> of this project (assignee claude + label in-progress)",
  args: [{ name: "N", summary: "Issue number", required: true }],
  options: [{ name: "dry-run", type: "boolean", summary: "Print the requests that would modify the issue; send none" }],
  examples: ["pai issue claim 12","pai issue claim 12 --dry-run"],
  seeAlso: ["pai issue release"],
  run: (ctx) => issueClaimCmd(String(ctx.args.N), { dryRun: ctx.opts["dry-run"] === true }),
},
{
  name: "release",
  summary: "Give issue N back",
  description: "Give issue N back.\n\nRelease forge issue <n> of this project (assignee claude + label in-progress)",
  args: [{ name: "N", summary: "Issue number", required: true }],
  options: [{ name: "dry-run", type: "boolean", summary: "Print the requests that would modify the issue; send none" }],
  examples: ["pai issue release 12","pai issue release 12 --dry-run"],
  seeAlso: ["pai issue claims","pai issue claim"],
  run: (ctx) => issueReleaseCmd(String(ctx.args.N), { dryRun: ctx.opts["dry-run"] === true }),
},
{
  name: "claims",
  summary: "List the issues of this project marked in-progress",
  description: "List the issues of this project marked in-progress.\n\nList open issues of this project carrying the in-progress label",
  examples: ["pai issue claims","pai issue claims"],
  seeAlso: ["pai issue stale","pai issue release"],
  run: (ctx) => issueClaimsCmd(),
},
{
  name: "stale",
  summary: "List open issues whose work is already merged",
  description: "List open issues whose work is already merged.\n\nList open issues that landed in the integration branch (merged branch named by number, or a 'fixes #N' commit subject; plain mentions do not count) or are idle (report only; never closes)",
  options: [{ name: "days", type: "string", value: "N", summary: "Idle threshold in days" }, { name: "json", type: "boolean", summary: "JSON output" }, { name: "dry-run", type: "boolean", summary: "Also show the handover-issue section the daemon would write; send nothing" }],
  examples: ["pai issue stale","pai issue stale --days 14 --json"],
  seeAlso: ["pai issue claims"],
  run: (ctx) => issueStaleCmd({ days: ctx.opts.days as string | undefined, json: ctx.opts.json === true, dryRun: ctx.opts["dry-run"] === true }),
},
];

export const issueCommand: CommandDef = {
  name: "issue",
  summary: "Claim and release forge issues for this project",
  description: "Claim and release forge issues for this project.",
  examples: ["pai issue claims","pai issue claim 12"],
  subcommands: issueSubcommands,
};
