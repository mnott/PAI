/** `pai memory ...`: search and index what was written down. */

import type { Command } from "commander";
import { OPT, type CommandDef, type OptDef, CliError } from "../define.js";
import { memoryBackendDetectCmd, memoryBackendUseCmd, memoryBackendProvisionCmd, memoryReembedCmd } from "./memory/backend.js";
import { memoryEmbedCmd } from "./memory/embed.js";
import { memoryIndexCmd } from "./memory/index-cmd.js";
import { memoryPassCmd } from "./memory/pass.js";
import { memorySearchCmd } from "./memory/search.js";
import { memorySourcesCmd } from "./memory/sources-cmd.js";
import { memoryStatusCmd, memorySettingsCmd } from "./memory/stats.js";

const background: OptDef = { name: "background", type: "boolean", summary: "Run at low priority so the computer stays responsive" };
const projectSlug = { name: "PROJECT", summary: "Project name as shown by `pai project list`" };

export const memoryIndexCommand: CommandDef = {
  name: "index",
  summary: "Read project notes and memory files into the search index",
  description:
    "Reads the notes and memory files of one project, or of all active projects, into the search index so `pai memory search` can find them. " +
    "If the background service is running and no project is named, it is asked to do the work; otherwise it runs here.",
  args: [{ ...projectSlug, summary: "Index only this project (default: all active projects)" }],
  options: [
    { name: "all", type: "boolean", summary: "All active projects (this is the default when no project is named)" },
    { name: "embed", type: "boolean", summary: "Also compute the meaning vectors for new text, so semantic search can use it" },
    { name: "direct", type: "boolean", summary: "Do not ask the background service; run here (for debugging)" },
    { ...background, summary: "Run at low priority (implies --direct)" },
  ],
  examples: ["pai memory index", "pai memory index my-project --embed", "pai memory index --background"],
  seeAlso: ["pai memory embed", "pai memory status"],
  run: (ctx) => memoryIndexCmd(ctx.args.PROJECT as string | undefined, {
    all: ctx.opts.all === true,
    embed: ctx.opts.embed === true,
    direct: ctx.opts.direct === true,
    background: ctx.opts.background === true,
  }),
};

export const memoryEmbedCommand: CommandDef = {
  name: "embed",
  summary: "Compute meaning vectors for indexed text that has none yet",
  description: "Semantic and hybrid search need a vector per text chunk. This fills in the missing ones, in batches; safe to stop and re-run.",
  args: [{ ...projectSlug, summary: "Only this project (default: all)" }],
  options: [
    { name: "batch-size", type: "number", value: "N", default: 50, summary: "Chunks to compute per batch" },
    { ...background },
  ],
  examples: ["pai memory embed", "pai memory embed my-project --batch-size 20", "pai memory embed --background"],
  seeAlso: ["pai memory index", "pai memory backend detect"],
  run: (ctx) => memoryEmbedCmd(ctx.args.PROJECT as string | undefined, {
    batchSize: ctx.opts["batch-size"] as number | undefined,
    background: ctx.opts.background === true,
  }),
};

export const memorySearchCommand: CommandDef = {
  name: "search",
  summary: "Search what the memory index knows",
  description:
    "Finds notes and memory files that match a query: by keywords (default), by meaning (semantic), or both (hybrid). " +
    "Results are re-ranked unless you turn that off, and recent items get a boost if you ask for one.",
  args: [{ name: "QUERY", required: true, summary: "What to look for" }],
  options: [
    { ...OPT.project, value: "SLUG", summary: "Only this project" },
    { name: "source", type: "string", value: "KIND", summary: "Only 'memory' files or only 'notes'" },
    { name: "limit", type: "number", value: "N", summary: "Maximum results (default from `pai memory settings`)" },
    { name: "mode", type: "string", value: "MODE", summary: "keyword (default), semantic or hybrid" },
    { name: "no-rerank", type: "boolean", summary: "Skip the second ranking pass (faster, a little less precise)" },
    { name: "recency", type: "number", value: "DAYS", summary: "Boost recent results: the score halves every DAYS days; 0 = off" },
  ],
  examples: ['pai memory search "release checklist"', 'pai memory search "retry loop" --project my-project --mode hybrid', 'pai memory search deploy --no-rerank --limit 5'],
  seeAlso: ["pai memory settings", "pai find"],
  run: (ctx) => memorySearchCmd(ctx.args.QUERY as string, {
    project: ctx.opts.project as string | undefined,
    source: ctx.opts.source as string | undefined,
    limit: ctx.opts.limit as string | undefined,
    mode: ctx.opts.mode as string | undefined,
    rerank: ctx.opts["no-rerank"] === true ? false : true,
    recency: ctx.opts.recency as string | undefined,
  }),
};

export const memoryStatusCommand: CommandDef = {
  name: "status",
  summary: "How much the memory index holds",
  description: "Shows the storage backend and the number of indexed files and chunks. For live counts per project use `pai daemon status`.",
  args: [{ ...projectSlug, summary: "Show this project only" }],
  examples: ["pai memory status", "pai memory status my-project"],
  seeAlso: ["pai memory sources", "pai daemon status"],
  run: (ctx) => memoryStatusCmd(ctx.args.PROJECT as string | undefined),
};

export const memorySettingsCommand: CommandDef = {
  name: "settings",
  summary: "Show or change the search settings",
  description:
    "With no arguments, lists the search settings (mode, rerank, recencyBoostDays, defaultLimit, snippetLength). " +
    "With a key, prints its value; with a key and a value, saves it to the PAI config file.",
  args: [
    { name: "KEY", summary: "Setting name" },
    { name: "VALUE", summary: "New value" },
  ],
  examples: ["pai memory settings", "pai memory settings mode", "pai memory settings mode hybrid"],
  seeAlso: ["pai config path"],
  run: (ctx) => memorySettingsCmd(ctx.args.KEY as string | undefined, ctx.args.VALUE as string | undefined),
};

export const memorySourcesCommand: CommandDef = {
  name: "sources",
  summary: "Where the indexed content comes from",
  description:
    "Shows what the indexer has taken in: composition by source, which roots content enters from, the heaviest single files, " +
    "and how many chunks are rewritten per day (which tells a finite backlog from a treadmill).",
  options: [{ name: "limit", type: "number", value: "N", default: 8, summary: "Rows per section" }],
  examples: ["pai memory sources", "pai memory sources --limit 20"],
  seeAlso: ["pai memory status"],
  run: (ctx) => memorySourcesCmd({ limit: ctx.opts.limit as number | undefined }),
};

export const memoryBackendDetectCommand: CommandDef = {
  name: "detect",
  summary: "Check which embedding backends work here",
  description: "Probes the available embedding backends (ollama, then transformers-cpu) and recommends the fastest.",
  examples: ["pai memory backend detect", "pai memory backend use ollama"],
  seeAlso: ["pai memory backend use"],
  run: () => memoryBackendDetectCmd(),
};

export const memoryBackendUseCommand: CommandDef = {
  name: "use",
  summary: "Choose the embedding backend",
  description: "Writes the backend to the config. It does not touch the index; an index that already holds vectors from another backend needs `pai memory reembed`.",
  args: [{ name: "ID", required: true, summary: "Backend id, e.g. ollama or transformers-cpu-q8" }],
  options: [{ name: "model", type: "string", value: "NAME", summary: "Model name on that backend" }],
  examples: ["pai memory backend use ollama", "pai memory backend use transformers-cpu-q8 --model my-model"],
  seeAlso: ["pai memory backend detect", "pai memory reembed"],
  run: (ctx) => memoryBackendUseCmd(ctx.args.ID as string, {
    model: ctx.opts.model as string | undefined,
  }),
};

export const memoryBackendProvisionCommand: CommandDef = {
  name: "provision",
  summary: "Download and set up a backend's model",
  description: "Only ollama needs this: it downloads the embedding model file and registers it with ollama.",
  args: [{ name: "BACKEND", required: true, summary: "Backend to set up (only: ollama)" }],
  examples: ["pai memory backend provision ollama", "pai memory backend use ollama"],
  seeAlso: ["pai memory backend use"],
  run: (ctx) => memoryBackendProvisionCmd(ctx.args.BACKEND as string),
};

export const memoryBackendCommand: CommandDef = {
  name: "backend",
  summary: "Embedding backends: detect, use, provision",
  description: "An index is bound to the backend that embedded it. Pick a backend here; switching an existing index also needs `pai memory reembed`.",
  examples: ["pai memory backend detect", "pai memory backend use ollama"],
  seeAlso: ["pai memory reembed"],
  subcommands: [memoryBackendDetectCommand, memoryBackendUseCommand, memoryBackendProvisionCommand],
};

export const memoryReembedCommand: CommandDef = {
  name: "reembed",
  summary: "Switch the index to another embedding backend",
  description:
    "Clears every stored vector (in batches, resumable) so the index can be refilled by the new backend with `pai memory embed`. " +
    "Keyword search keeps working meanwhile. Without --yes it only prints the plan and refuses.",
  options: [
    { name: "backend", type: "string", value: "ID", summary: "Target backend (default: the configured one); also written to the config" },
    { name: "yes", type: "boolean", summary: "Go ahead; without it only the plan is printed" },
  ],
  examples: ["pai memory reembed", "pai memory reembed --backend ollama --yes"],
  seeAlso: ["pai memory embed", "pai memory backend use"],
  run: (ctx) => memoryReembedCmd({
    backend: ctx.opts.backend as string | undefined,
    yes: ctx.opts.yes === true,
  }),
};

const memoryPassCommand: CommandDef = {
  name: "pass",
  summary: "Internal: one background pass started by the daemon",
  description: "Used by the background service to run an index or embed pass at low priority and report one JSON line. Not meant to be typed.",
  args: [{ name: "NAME", required: true, summary: "index, embed or noop" }],
  options: [{ name: "sleep", type: "number", value: "MS", default: 0, summary: "noop pass only: sleep this many milliseconds" }],
  examples: ["pai memory pass noop --sleep 10", "pai memory pass index"],
  run: (ctx) => memoryPassCmd(ctx.args.NAME as string, { sleep: ctx.opts.sleep as number | undefined }),
};

export const memoryCommand: CommandDef = {
  name: "memory",
  summary: "Search and index your notes and memory files",
  description: "The memory index makes notes and memory files searchable. `pai memory search` is the one you want most days.",
  examples: ["pai memory search \"release checklist\"", "pai memory status", "pai memory index"],
  seeAlso: ["pai find", "pai kg", "pai zettel"],
  subcommands: [
    memorySearchCommand,
    memoryStatusCommand,
    memoryIndexCommand,
    memoryEmbedCommand,
    memorySettingsCommand,
    memorySourcesCommand,
    memoryBackendCommand,
    memoryReembedCommand,
    memoryPassCommand,
  ],
};
