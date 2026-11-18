/** `pai code ...`: the code graph of a repository (symbols, references, blast radius). */

import { OPT, CliError, type CommandDef, type OptDef, type RunContext } from "../define.js";
import { getStorageBackend } from "../../storage/factory.js";
import * as cg from "../../codegraph/api.js";
import { findSummary, localSummaryModel, summarizeRepo } from "../../codegraph/summaries.js";
import { getRegistryBackend } from "../../storage/factory.js";
import { reexecBackground } from "../../daemon/pass-priority.js";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { relate } from "../../codegraph/relate.js";
import { registeredProjects } from "../../codegraph/projects.js";
import { loadConfig } from "../../daemon/config.js";

const root: OptDef = { name: "root", type: "string", value: "DIR", summary: "Repository root (default: the repo around the current directory)" };
const json: OptDef = { ...OPT.json, summary: "Output raw JSON" };
const limit: OptDef = { name: "limit", type: "number", value: "N", default: 20, summary: "Maximum results" };

function rootOf(ctx: RunContext): string {
  return cg.resolveRoot((ctx.opts.root as string | undefined) ?? process.cwd());
}

function words(ctx: RunContext, key: string): string {
  const v = ctx.args[key];
  const s = Array.isArray(v) ? v.join(" ") : (v ?? "");
  if (!s.trim()) throw new CliError(`Missing ${key.toLowerCase()}`, "Run: pai code --help");
  return s;
}

function num(v: unknown): number | undefined {
  return v === undefined || v === "" ? undefined : Number(v);
}

function sym(h: cg.SymbolHit): string {
  return `${h.kind} ${h.qualifiedName}  ${h.file}:${h.startLine}`;
}

function ref(h: cg.RefHit): string {
  return `${h.file}:${h.line}  ${h.kind} ${h.symbol ? h.symbol.qualifiedName : h.name}`;
}

function print(ctx: RunContext, data: unknown, lines: string[]): void {
  console.log(ctx.opts.json === true ? JSON.stringify(data, null, 2) : lines.length ? lines.join("\n") : "No results.");
}

export const codeCommand: CommandDef = {
  name: "code",
  summary: "Map a repository: symbols, callers and blast radius",
  description:
    "The code graph indexes a repository's definitions and references into PAI's own database (Postgres, or SQLite as fallback). " +
    "It reads TypeScript/TSX, JavaScript, Swift and Python; other files get a file row only. " +
    "The index is reconciled with the repo whenever you query it; a first index of an unindexed repo is started in the background (one at a time) when a session opens there, and after each worker merge. Edits are only marked; the next query re-reads them.",
  examples: ["pai code index", "pai code explore how does the router pick a provider", "pai code callers resolveRoot"],
  seeAlso: ["pai memory search", "pai kg"],
  subcommands: [
    {
      name: "index",
      summary: "Index a repository",
      description: "Scans the files git tracks (up to 1 MB each, skipping node_modules, dist, build and vendor) and stores their symbols and references. Only changed files are re-read unless you pass --force.",
      args: [{ name: "ROOT", summary: "Repository root (default: the repo around the current directory)" }],
      options: [{ name: "force", type: "boolean", default: false, summary: "Re-read every file" }, root, json],
      examples: ["pai code index", "pai code index ~/dev/my-repo --force"],
      seeAlso: ["pai code status"],
      run: async (ctx) => {
        const r = cg.resolveRoot((ctx.args.ROOT as string | undefined) ?? (ctx.opts.root as string | undefined) ?? process.cwd());
        const s = await cg.indexRepo(await getStorageBackend(), r, { force: ctx.opts.force === true });
        print(ctx, s, [
          `root      ${s.root}`,
          `backend   ${s.backend}`,
          `files     ${s.files}`,
          `symbols   ${s.symbols}`,
          `refs      ${s.refs}`,
          `resolved  ${s.resolvedRefs}`,
          `changed   ${s.changed}`,
          `deleted   ${s.deleted}`,
          `time      ${s.ms} ms`,
        ]);
      },
    },
    {
      name: "explore",
      summary: "Answer a question about the code in one call",
      description: "Finds the definitions that match your question or symbol names and prints their source, callers and blast radius within a token budget. Indexes the repo first if needed.",
      args: [{ name: "QUERY", summary: "A question or symbol names", required: true, variadic: true }],
      options: [
        root,
        { name: "budget", type: "number", value: "TOKENS", default: 4000, summary: "Output budget in tokens" },
        { name: "depth", type: "number", value: "N", summary: "How far to follow calls" },
        json,
      ],
      examples: ["pai code explore ensureFresh", "pai code explore where are sessions routed --budget 8000"],
      seeAlso: ["pai code search", "pai code impact"],
      run: async (ctx) => {
        const backend = await getStorageBackend();
        const r = rootOf(ctx);
        await cg.ensureFresh(backend, r);
        const res = await cg.explore(backend, r, words(ctx, "QUERY"), {
          budgetTokens: num(ctx.opts.budget), depth: num(ctx.opts.depth), projects: await registeredProjects().catch(() => []),
        });
        console.log(ctx.opts.json === true ? JSON.stringify(res, null, 2) : res.text);
      },
    },
    {
      name: "search",
      summary: "Find symbols by name",
      description: "Lists definitions whose name matches the query.",
      args: [{ name: "QUERY", summary: "Part of a symbol name", required: true, variadic: true }],
      options: [root, limit, json],
      examples: ["pai code search tunnel", "pai code search Storage --limit 5 --json"],
      seeAlso: ["pai code explore"],
      run: async (ctx) => {
        const backend = await getStorageBackend();
        const r = rootOf(ctx);
        await cg.ensureFresh(backend, r);
        const hits = await cg.searchSymbols(backend, r, words(ctx, "QUERY"), num(ctx.opts.limit));
        print(ctx, hits, hits.map(sym));
      },
    },
    {
      name: "callers",
      summary: "Who calls or uses a symbol",
      description: "Lists the places that reference the named symbol.",
      args: [{ name: "NAME", summary: "Symbol name", required: true }],
      options: [root, limit, json],
      examples: ["pai code callers resolveRoot", "pai code callers indexRepo --json"],
      seeAlso: ["pai code callees", "pai code impact"],
      run: async (ctx) => {
        const backend = await getStorageBackend();
        const r = rootOf(ctx);
        await cg.ensureFresh(backend, r);
        const hits = await cg.callers(backend, r, ctx.args.NAME as string, num(ctx.opts.limit));
        print(ctx, hits, hits.map(ref));
      },
    },
    {
      name: "callees",
      summary: "What a symbol calls or uses",
      description: "Lists the references made from inside the named symbol.",
      args: [{ name: "NAME", summary: "Symbol name", required: true }],
      options: [root, limit, json],
      examples: ["pai code callees explore", "pai code callees explore --json"],
      seeAlso: ["pai code callers"],
      run: async (ctx) => {
        const backend = await getStorageBackend();
        const r = rootOf(ctx);
        await cg.ensureFresh(backend, r);
        const hits = await cg.callees(backend, r, ctx.args.NAME as string, num(ctx.opts.limit));
        print(ctx, hits, hits.map(ref));
      },
    },
    {
      name: "impact",
      summary: "What a change to a symbol could break",
      description: "Follows callers outward to the given depth and lists the affected files and symbols.",
      args: [{ name: "NAME", summary: "Symbol name", required: true }],
      options: [root, { name: "depth", type: "number", value: "N", default: 2, summary: "How many caller levels to follow" }, json],
      examples: ["pai code impact resolveRoot", "pai code impact resolveRoot --depth 3"],
      seeAlso: ["pai code callers"],
      run: async (ctx) => {
        const backend = await getStorageBackend();
        const r = rootOf(ctx);
        await cg.ensureFresh(backend, r);
        const res = await cg.impact(backend, r, ctx.args.NAME as string, num(ctx.opts.depth));
        print(ctx, res, [`${res.files.length} files, ${res.symbols.length} symbols`, ...res.files.map((f) => `  ${f}`), ...res.symbols.map((s) => `  ${sym(s)}`)]);
      },
    },
    {
      name: "summarize",
      summary: "Write module and repo summaries with the local model",
      description:
        "For every module (a directory with source files) and the repo, stores a short summary: purpose (written by the local model from signatures, doc comments and top references), entry points, what it depends on and what depends on it. " +
        "Runs at background priority, one module at a time, and never uses a cloud model; it stops with an error when no local model is running. " +
        "A module is regenerated only when its source changed (--force redoes all). Summaries are also stored as memory chunks, so the next embed pass makes them searchable with memory search.",
      options: [
        root,
        { name: "project", type: "string", value: "SLUG", summary: "A registered project instead of the current repo" },
        { name: "all", type: "boolean", default: false, summary: "Every registered project whose code graph is already indexed" },
        { name: "changed", type: "boolean", default: true, summary: "Only modules whose source changed since their summary (default)" },
        { name: "force", type: "boolean", default: false, summary: "Regenerate every summary" },
        { name: "max-minutes", type: "number", value: "N", summary: "Start no new module after N minutes" },
        json,
      ],
      examples: ["pai code summarize", "pai code summarize --project pai --changed", "pai code summarize --all --max-minutes 90"],
      seeAlso: ["pai code summary", "pai code explore"],
      run: async (ctx) => {
        reexecBackground();
        const backend = await getStorageBackend();
        const registry = await getRegistryBackend();
        const targets: Array<{ root: string; slug: string }> = [];
        if (ctx.opts.all === true) {
          for (const p of await registry.listProjects({ status: "active" })) {
            if (existsSync(p.root_path) && (await cg.status(backend, p.root_path)).indexed) targets.push({ root: p.root_path, slug: p.slug });
          }
        } else if (typeof ctx.opts.project === "string") {
          const p = await registry.getProjectBySlug(ctx.opts.project);
          if (!p) throw new CliError(`No project with slug ${ctx.opts.project}`, "Run: pai project list");
          targets.push({ root: p.root_path, slug: p.slug });
        } else {
          const r = rootOf(ctx);
          const p = await registry.getProjectByRootPath(r);
          targets.push({ root: r, slug: p?.slug ?? basename(r) });
        }
        if (!targets.length) throw new CliError("Nothing to summarize", "Run: pai code index");
        const model = await localSummaryModel();
        const maxMin = num(ctx.opts["max-minutes"]);
        const t0 = Date.now();
        const out = [];
        for (const t of targets) {
          await cg.ensureFresh(backend, t.root);
          const left = maxMin === undefined ? undefined : Math.max(0, maxMin * 60_000 - (Date.now() - t0));
          out.push(await summarizeRepo(backend, t.root, {
            model, slug: t.slug, changed: ctx.opts.force !== true, maxMs: left,
            log: (m) => { if (ctx.opts.json !== true) console.error(`[${t.slug}] ${m}`); },
          }));
        }
        print(ctx, out, out.map((r) => `${r.slug}: ${r.modules} modules, ${r.summarized} summarized, ${r.unchanged} unchanged, ${r.failed} failed${r.budgetHit ? " (time budget reached)" : ""} in ${(r.ms / 1000).toFixed(1)} s`));
      },
    },
    {
      name: "summary",
      summary: "Show the stored summary of a module or repo",
      description: "Prints the summary for a key (code:<slug>:<path>), a directory or a file path; a path without its own summary falls back to the enclosing module, then the repo. Use . for the repo.",
      args: [{ name: "TARGET", summary: "Key, directory or file path", required: true }],
      options: [root, json],
      examples: ["pai code summary src/codegraph", "pai code summary code:pai:src/router", "pai code summary ."],
      seeAlso: ["pai code summarize", "pai code explore"],
      run: async (ctx) => {
        const row = await findSummary((await getStorageBackend()).codeGraph(), rootOf(ctx), ctx.args.TARGET as string);
        if (!row) throw new CliError(`No summary stored for ${ctx.args.TARGET}`, "Run: pai code summarize");
        print(ctx, row, [row.key, row.summary, "", `model ${row.model}, generated ${new Date(row.generatedAt).toISOString()}`]);
      },
    },
    {
      name: "relate",
      summary: "Derive relations between projects and notes",
      description:
        "Reads the code graphs of the indexed registered projects and writes relations to the knowledge graph (kg_triples): depends-on (manifests), calls-api (routes and MCP tools), shares-protocol (same message types), duplicates (near-identical functions) and, from the vault notes, mentions and cites. " +
        "A relation that disappears gets an end date, never deleted. Index the projects first (pai code index).",
      options: [
        { name: "project", type: "string", value: "SLUG", summary: "Write only this project's relations (all projects are still read)" },
        { name: "all", type: "boolean", default: false, summary: "All registered projects and the notes (the default)" },
        json,
      ],
      examples: ["pai code relate", "pai code relate --project my-app"],
      seeAlso: ["pai graph related", "pai code index"],
      run: async (ctx) => {
        const backend = await getStorageBackend();
        const slug = ctx.opts.project as string | undefined;
        const rep = await relate(backend, await registeredProjects(), { only: slug ? [slug] : undefined, vaultPath: loadConfig().vaultPath || undefined });
        print(ctx, rep, [
          `projects  ${rep.projects}`,
          `triples   ${rep.triples} (added ${rep.added}, ended ${rep.closed}, unchanged ${rep.kept})`,
          ...Object.entries(rep.byPredicate).map(([k, v]) => `  ${k.padEnd(16)} ${v}`),
          ...rep.samples.map((x) => `  e.g. ${x.subject} ${x.predicate} ${x.object}`),
        ]);
      },
    },
    {
      name: "status",
      summary: "Show what is indexed for a repository",
      description: "Prints whether the repo is indexed, the counts, languages, last full index, files marked dirty by edits, and an index running now. Does not index anything.",
      args: [{ name: "ROOT", summary: "Repository root (default: the repo around the current directory)" }],
      options: [root, json],
      examples: ["pai code status", "pai code status ~/dev/my-repo --json"],
      seeAlso: ["pai code index"],
      run: async (ctx) => {
        const s = await cg.status(await getStorageBackend(), cg.resolveRoot((ctx.args.ROOT as string | undefined) ?? (ctx.opts.root as string | undefined) ?? process.cwd()));
        print(ctx, s, [
          `root      ${s.root}`,
          `backend   ${s.backend}`,
          `indexed   ${s.indexed ? "yes" : "no"}`,
          `files     ${s.files}`,
          `symbols   ${s.symbols}`,
          `refs      ${s.refs} (${s.resolvedRefs} resolved)`,
          `languages ${Object.entries(s.byLanguage).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`,
          `last full index ${s.lastIndexedAt ?? "never"}`,
          `dirty     ${s.dirty} file(s) marked since the last query`,
          `running   ${s.indexing ? `index of ${s.indexing.root} (pid ${s.indexing.pid}, since ${s.indexing.startedAt})` : "no index running"}`,
        ]);
      },
    },
  ],
};
