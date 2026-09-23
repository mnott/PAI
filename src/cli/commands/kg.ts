/**
 * pai kg <sub-command>
 *
 * Temporal knowledge graph management:
 *   pai kg backfill [--project SLUG] [--limit N] [--dry-run]
 *   pai kg query    [--subject S] [--predicate P] [--object O] [--as-of DATE] [--project SLUG]
 *   pai kg list     [--project SLUG] [--limit N]
 *   pai kg stats
 *
 * All commands require the Postgres backend (KG tables live in Postgres).
 */

import type { Command } from "commander";
import type { StorageBackend } from "../../storage/interface.js";

import { ok, warn, err, dim, bold, header } from "../utils.js";
import { loadConfig, CONFIG_FILE } from "../../daemon/config.js";
import { createStorageBackend, getRegistryBackend } from "../../storage/factory.js";
import { backfillKgFromNotes } from "../../memory/kg-backfill.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getBackend(): Promise<StorageBackend> {
  const config = loadConfig();
  if (config.storageBackend !== "postgres") {
    console.error(err("  KG commands require Postgres backend."));
    console.error(dim(`  Set "storageBackend": "postgres" in ${CONFIG_FILE}`));
    process.exit(1);
  }
  const backend = await createStorageBackend(config);
  if (!backend.supportsPostgresFeatures) {
    console.error(err("  Postgres backend unavailable — fell back to SQLite."));
    process.exit(1);
  }
  return backend;
}

function shorten(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ---------------------------------------------------------------------------
// pai kg backfill
// ---------------------------------------------------------------------------

async function cmdBackfill(opts: {
  project?: string;
  limit?: string;
  dryRun?: boolean;
}): Promise<void> {
  const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
  if (limit !== undefined && (isNaN(limit) || limit < 1)) {
    console.error(err("  --limit must be a positive integer"));
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log(header("  PAI KG Backfill"));
  console.log();
  if (opts.project) console.log(`  ${bold("Project:")} ${opts.project}`);
  if (limit) console.log(`  ${bold("Limit:")}   ${limit}`);
  if (opts.dryRun) console.log(`  ${bold("Mode:")}    ${warn("dry-run")}`);
  console.log();

  try {
    const result = await backfillKgFromNotes({
      projectSlug: opts.project,
      limit,
      dryRun: opts.dryRun,
      onProgress: (current, total, note) => {
        const short = shorten(note.replace(process.env.HOME ?? "", "~"), 70);
        process.stdout.write(`  [${current}/${total}] ${dim(short)}\n`);
      },
    });

    console.log();
    console.log(ok("  Backfill complete"));
    console.log(`    Notes processed:    ${bold(String(result.notes_processed))}`);
    console.log(`    Triples extracted:  ${bold(String(result.triples_extracted))}`);
    console.log(`    Triples added:      ${bold(String(result.triples_added))}`);
    console.log(`    Triples superseded: ${bold(String(result.triples_superseded))}`);
    if (result.errors > 0) {
      console.log(`    ${warn("Errors:")}             ${result.errors}`);
    }
    console.log();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(err(`  ${msg}`));
    process.exitCode = 1;
    return;
  }
}

// ---------------------------------------------------------------------------
// pai kg query
// ---------------------------------------------------------------------------

async function cmdQuery(opts: {
  subject?: string;
  predicate?: string;
  object?: string;
  asOf?: string;
  project?: string;
  json?: boolean;
}): Promise<void> {
  const backend = await getBackend();
  const registry = await getRegistryBackend();
  const close = () => backend.close();
  try {
    let projectId: number | undefined;
    if (opts.project) {
      const row = await registry.getProjectBySlug(opts.project);
      if (!row) {
        console.error(warn(`  Project not found in Postgres: ${opts.project}`));
      } else {
        projectId = row.id;
      }
    }

    const asOf = opts.asOf ? new Date(opts.asOf) : undefined;
    if (asOf && isNaN(asOf.getTime())) {
      console.error(err(`  Invalid --as-of date: ${opts.asOf}`));
      process.exitCode = 1;
      return;
    }

    const triples = await backend.queryKgTriples({
      subject: opts.subject,
      predicate: opts.predicate,
      object: opts.object,
      project_id: projectId,
      as_of: asOf,
    });

    if (opts.json) {
      console.log(JSON.stringify(triples, null, 2));
      return;
    }

    console.log();
    console.log(header(`  ${triples.length} triple(s)`));
    console.log();
    for (const t of triples) {
      const validity = t.valid_to
        ? dim(`(invalidated ${t.valid_to.toISOString().slice(0, 10)})`)
        : dim(`(valid since ${t.valid_from.toISOString().slice(0, 10)})`);
      console.log(
        `  ${bold(t.subject)} ${dim("·")} ${t.predicate} ${dim("·")} ${t.object}  ${validity}`
      );
    }
    console.log();
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// pai kg list
// ---------------------------------------------------------------------------

async function cmdList(opts: { project?: string; limit?: string }): Promise<void> {
  const limit = opts.limit ? parseInt(opts.limit, 10) : 50;
  const backend = await getBackend();
  const registry = await getRegistryBackend();
  const close = () => backend.close();
  try {
    let projectId: number | undefined;
    if (opts.project) {
      const row = await registry.getProjectBySlug(opts.project);
      if (row) projectId = row.id;
    }

    const triples = await backend.queryKgTriples({ project_id: projectId });
    const slice = triples.slice(0, limit);

    console.log();
    console.log(
      header(`  ${slice.length} of ${triples.length} currently-valid triple(s)`)
    );
    console.log();
    for (const t of slice) {
      console.log(
        `  ${bold(t.subject)} ${dim("·")} ${t.predicate} ${dim("·")} ${t.object}`
      );
    }
    if (triples.length > slice.length) {
      console.log();
      console.log(dim(`  (${triples.length - slice.length} more — increase --limit)`));
    }
    console.log();
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// pai kg stats
// ---------------------------------------------------------------------------

async function cmdStats(): Promise<void> {
  const backend = await getBackend();
  try {
    const stats = await backend.getKgStats();
    console.log();
    console.log(header("  PAI KG Stats"));
    console.log();
    console.log(`  ${bold("Total triples:")}        ${stats.total}`);
    console.log(`  ${bold("Currently valid:")}      ${stats.valid}`);
    console.log(`  ${bold("Invalidated:")}          ${stats.invalidated}`);
    console.log(`  ${bold("Distinct subjects:")}    ${stats.subjects}`);
    console.log(`  ${bold("Distinct predicates:")}  ${stats.predicates}`);
    console.log(`  ${bold("Contradictions:")}       ${stats.contradictions}`);
    console.log();
  } finally {
    await backend.close();
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerKgCommands(kgCmd: Command): void {
  kgCmd
    .command("backfill")
    .description("Populate the KG from existing session notes (idempotent)")
    .option("--project <slug>", "Restrict backfill to a single project")
    .option("--limit <n>", "Maximum number of notes to process")
    .option("--dry-run", "List notes that would be processed without extracting")
    .action(async (opts: { project?: string; limit?: string; dryRun?: boolean }) => {
      await cmdBackfill(opts);
    });

  kgCmd
    .command("query")
    .description("Query KG triples by subject, predicate, object, time, or project")
    .option("--subject <s>", "Filter by subject")
    .option("--predicate <p>", "Filter by predicate")
    .option("--object <o>", "Filter by object")
    .option("--as-of <date>", "Point-in-time query (YYYY-MM-DD or ISO 8601)")
    .option("--project <slug>", "Restrict to a project slug")
    .option("--json", "Output raw JSON")
    .action(
      async (opts: {
        subject?: string;
        predicate?: string;
        object?: string;
        asOf?: string;
        project?: string;
        json?: boolean;
      }) => {
        await cmdQuery(opts);
      }
    );

  kgCmd
    .command("list")
    .description("List currently-valid triples")
    .option("--project <slug>", "Restrict to a project slug")
    .option("--limit <n>", "Maximum triples to print", "50")
    .action(async (opts: { project?: string; limit?: string }) => {
      await cmdList(opts);
    });

  kgCmd
    .command("stats")
    .description("Show triple counts and contradiction count")
    .action(async () => {
      await cmdStats();
    });
}
