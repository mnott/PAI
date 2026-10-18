/** `pai observation ...`: what was noticed while working (decisions, bug fixes, discoveries). */

import { OPT, type CommandDef, type OptDef } from "../define.js";
import { observationListCmd, observationSearchCmd, observationStatsCmd } from "../lib/observation.js";

const project: OptDef = { ...OPT.project, value: "SLUG", summary: "Only this project" };
const type: OptDef = { name: "type", type: "string", value: "KIND", summary: "Only this kind: decision, bugfix, feature, refactor, discovery, change" };
const limit: OptDef = { name: "limit", type: "number", value: "N", default: 20, summary: "Maximum results" };

export const observationCommand: CommandDef = {
  name: "observation",
  summary: "Notes the system took while you worked",
  description: "Observations are short records of decisions, fixes and discoveries captured during sessions. List, search and count them here.",
  examples: ["pai observation list", 'pai observation search "retry"', "pai observation stats"],
  seeAlso: ["pai memory search", "pai kg"],
  subcommands: [
    {
      name: "list",
      summary: "Show recent observations",
      description: "Lists the newest observations, optionally narrowed by project, kind or session.",
      options: [project, type, { name: "session", type: "string", value: "ID", summary: "Only this session id" }, limit],
      examples: ["pai observation list", "pai observation list --type decision --limit 5"],
      seeAlso: ["pai observation search"],
      run: async (ctx) => {
        return await observationListCmd({
          project: ctx.opts.project as string | undefined,
          type: ctx.opts.type as string | undefined,
          session: ctx.opts.session as string | undefined,
          limit: ctx.opts.limit?.toString(),
        });
      },
    },
    {
      name: "search",
      summary: "Search observations by title or text",
      description: "Finds observations whose title or narrative contains the query.",
      args: [{ name: "QUERY", required: true, summary: "What to look for" }],
      options: [project, type, limit],
      examples: ['pai observation search "retry"', 'pai observation search cache --type bugfix'],
      seeAlso: ["pai observation list"],
      run: async (ctx) => {
        return await observationSearchCmd(ctx.args.QUERY as string, {
          project: ctx.opts.project as string | undefined,
          type: ctx.opts.type as string | undefined,
          limit: ctx.opts.limit?.toString(),
        });
      },
    },
    {
      name: "stats",
      summary: "Totals by kind and by project",
      description: "Shows how many observations exist, split by kind and by project.",
      examples: ["pai observation stats", "pai observation list --limit 5"],
      seeAlso: ["pai observation list"],
      run: async () => {
        return await observationStatsCmd();
      },
    },
  ],
};
