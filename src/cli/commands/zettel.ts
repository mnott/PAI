/** `pai zettel ...`: ask questions of a linked-notes vault. */

import type { CommandDef, OptDef } from "../define.js";
import { zettelExploreCmd } from "./zettel/explore.js";
import { zettelHealthCmd } from "./zettel/health.js";
import { zettelSurpriseCmd } from "./zettel/surprise.js";
import { zettelConverseCmd } from "./zettel/converse.js";
import { zettelThemesCmd } from "./zettel/themes.js";
import { zettelSuggestCmd } from "./zettel/suggest.js";

const vaultId: OptDef = { name: "vault-project-id", type: "string", value: "N", summary: "Required. Id of the vault's project (see `pai project list`)" };
const limit = (n: number, what: string): OptDef => ({ name: "limit", type: "number", value: "N", default: n, summary: `Maximum ${what}` });
const NOTE = { name: "NOTE", required: true, summary: "Note path or title" };

export const zettelCommand: CommandDef = {
  name: "zettel",
  summary: "Explore the links between your notes",
  description:
    "Works on a vault of linked notes: follow link chains, find surprising connections, ask questions, spot themes, check structural health. " +
    "Commands that need to know which vault take --vault-project-id.",
  examples: ["pai zettel health", "pai zettel explore my-note --depth 2", "pai zettel themes --vault-project-id 3"],
  seeAlso: ["pai obsidian", "pai memory search"],
  subcommands: [
    {
      name: "explore",
      summary: "Follow link chains from a note",
      description: "Starting at a note, walks the links outward and prints what it reaches.",
      args: [NOTE],
      options: [
        { name: "depth", type: "number", value: "N", default: 3, summary: "How far to follow links (1-10)" },
        { name: "direction", type: "string", value: "DIR", default: "both", summary: "forward, backward or both" },
        { name: "mode", type: "string", value: "MODE", default: "all", summary: "sequential, associative or all" },
      ],
      examples: ["pai zettel explore my-note", "pai zettel explore my-note --depth 2 --direction forward"],
      seeAlso: ["pai zettel suggest"],
      run: (ctx) => zettelExploreCmd(ctx.args.NOTE as string, {
        depth: ctx.opts.depth === undefined ? undefined : Number(ctx.opts.depth),
        direction: ctx.opts.direction === undefined ? undefined : String(ctx.opts.direction),
        mode: ctx.opts.mode === undefined ? undefined : String(ctx.opts.mode),
      }),
    },
    {
      name: "surprise",
      summary: "Find notes that are alike in meaning but far apart in links",
      description: "Surprising connections: pairs of notes that say similar things yet are not linked near each other.",
      args: [NOTE],
      options: [
        vaultId,
        limit(10, "results"),
        { name: "min-similarity", type: "number", value: "F", default: 0.3, summary: "Least similarity to accept (0-1)" },
        { name: "min-distance", type: "number", value: "N", default: 3, summary: "Least link distance to accept" },
      ],
      examples: ["pai zettel surprise my-note --vault-project-id 3", "pai zettel surprise my-note --vault-project-id 3 --limit 5"],
      seeAlso: ["pai zettel suggest"],
      run: (ctx) => zettelSurpriseCmd(ctx.args.NOTE as string, {
        vaultProjectId: ctx.opts["vault-project-id"] as string | number | undefined,
        limit: ctx.opts.limit as number | undefined,
        minSimilarity: ctx.opts["min-similarity"] as number | undefined,
        minDistance: ctx.opts["min-distance"] as number | undefined,
      }),
    },
    {
      name: "converse",
      summary: "Ask the vault a question",
      description: "Finds the notes relevant to a question and prints a prompt that bundles them, ready to hand to a model.",
      args: [{ name: "QUESTION", required: true, summary: "What you want to know" }],
      options: [
        vaultId,
        { name: "depth", type: "number", value: "N", default: 2, summary: "How far to expand around matching notes" },
        limit(15, "notes to include"),
      ],
      examples: ['pai zettel converse "what did we decide about caching?" --vault-project-id 3', 'pai zettel converse "why did the build break" --vault-project-id 3 --depth 1'],
      seeAlso: ["pai memory search"],
      run: (ctx) => zettelConverseCmd(ctx.args.QUESTION as string, {
        vaultProjectId: ctx.opts["vault-project-id"] as string | number | undefined,
        depth: ctx.opts.depth as number | undefined,
        limit: ctx.opts.limit as number | undefined,
      }),
    },
    {
      name: "themes",
      summary: "Spot topics emerging in recent notes",
      description: "Clusters recently edited notes by similarity and names the groups.",
      options: [
        vaultId,
        { name: "days", type: "number", value: "N", default: 30, summary: "Look back this many days" },
        { name: "min-size", type: "number", value: "N", default: 3, summary: "Fewest notes in a theme" },
        { name: "max-themes", type: "number", value: "N", default: 10, summary: "Most themes to show" },
        { name: "threshold", type: "number", value: "F", default: 0.65, summary: "How alike notes must be to group (0-1)" },
      ],
      examples: ["pai zettel themes --vault-project-id 3", "pai zettel themes --vault-project-id 3 --days 7"],
      seeAlso: ["pai zettel health"],
      run: (ctx) => zettelThemesCmd({
        vaultProjectId: ctx.opts["vault-project-id"] as string | number | undefined,
        days: ctx.opts.days as number | undefined,
        minSize: ctx.opts["min-size"] as number | undefined,
        maxThemes: ctx.opts["max-themes"] as number | undefined,
        threshold: ctx.opts.threshold as number | undefined,
      }),
    },
    {
      name: "health",
      summary: "Check the vault for dead links and orphans",
      description: "Structural audit: dead links, orphan notes, disconnected groups and weakly connected notes.",
      options: [
        { name: "scope", type: "string", value: "SCOPE", default: "full", summary: "full, recent or project" },
        { name: "project", type: "string", value: "PATH", summary: "Project path prefix (needs --scope project)" },
        { name: "days", type: "number", value: "N", default: 30, summary: "Look-back window (needs --scope recent)" },
        { name: "include", type: "string", value: "LIST", summary: "Comma list of: dead_links, orphans, disconnected, low_connectivity" },
      ],
      examples: ["pai zettel health", "pai zettel health --scope recent --days 7", "pai zettel health --include dead_links,orphans"],
      seeAlso: ["pai zettel themes"],
      run: (ctx) => zettelHealthCmd({
        scope: ctx.opts.scope as string | undefined,
        project: ctx.opts.project as string | undefined,
        days: ctx.opts.days as number | undefined,
        include: ctx.opts.include as string | undefined,
      }),
    },
    {
      name: "suggest",
      summary: "Suggest new links for a note",
      description: "Proposes notes the given note should probably link to.",
      args: [NOTE],
      options: [
        vaultId,
        limit(5, "suggestions"),
        { name: "no-exclude-linked", type: "boolean", summary: "Also suggest notes that are already linked" },
      ],
      examples: ["pai zettel suggest my-note --vault-project-id 3", "pai zettel suggest my-note --vault-project-id 3 --limit 10"],
      seeAlso: ["pai zettel explore"],
      run: (ctx) => zettelSuggestCmd(ctx.args.NOTE as string, {
        vaultProjectId: ctx.opts["vault-project-id"] as string | number | undefined,
        limit: ctx.opts.limit as number | undefined,
        excludeLinked: ctx.opts["no-exclude-linked"] !== true,
      }),
    },
  ],
};
