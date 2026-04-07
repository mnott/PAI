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
import type { Pool } from "pg";

import { ok, warn, err, dim, bold, header } from "../utils.js";
import { loadConfig } from "../../daemon/config.js";
import { createStorageBackend } from "../../storage/factory.js";
import { kgQuery } from "../../memory/kg.js";
import { backfillKgFromNotes } from "../../memory/kg-backfill.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getPool(): Promise<{ pool: Pool; close: () => Promise<void> }> {
  const config = loadConfig();
  if (config.storageBackend !== "postgres") {
    console.error(err("  KG commands require Postgres backend."));
    console.error(dim('  Set "storageBackend": "postgres" in ~/.config/pai/config.json'));
    process.exit(1);
  }
  const backend = await createStorageBackend(config);
  if (backend.backendType !== "postgres") {
    console.error(err("  Postgres backend unavailable — fell back to SQLite."));
    process.exit(1);
  }
  const pool = (backend as unknown as { getPool(): Pool }).getPool();
  return { pool, close: () => backend.close() };
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
    process.exit(1);
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
    process.exit(1);
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
  const { pool, close } = await getPool();
  try {
    let projectId: number | undefined;
    if (opts.project) {
      const r = await pool.query<{ id: number }>(
        "SELECT id FROM projects WHERE slug = $1 LIMIT 1",
        [opts.project]
      );
      if (r.rows.length === 0) {
        console.error(warn(`  Project not found in Postgres: ${opts.project}`));
      } else {
        projectId = r.rows[0].id;
      }
    }

    const asOf = opts.asOf ? new Date(opts.asOf) : undefined;
    if (asOf && isNaN(asOf.getTime())) {
      console.error(err(`  Invalid --as-of date: ${opts.asOf}`));
      process.exit(1);
    }

    const triples = await kgQuery(pool, {
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
  const { pool, close } = await getPool();
  try {
    let projectId: number | undefined;
    if (opts.project) {
      const r = await pool.query<{ id: number }>(
        "SELECT id FROM projects WHERE slug = $1 LIMIT 1",
        [opts.project]
      );
      if (r.rows.length > 0) projectId = r.rows[0].id;
    }

    const triples = await kgQuery(pool, { project_id: projectId });
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
  const { pool, close } = await getPool();
  try {
    const totals = await pool.query<{
      total: string;
      valid: string;
      invalidated: string;
      subjects: string;
      predicates: string;
    }>(
      `SELECT
         COUNT(*)::text                                            AS total,
         COUNT(*) FILTER (WHERE valid_to IS NULL)::text            AS valid,
         COUNT(*) FILTER (WHERE valid_to IS NOT NULL)::text        AS invalidated,
         COUNT(DISTINCT subject)::text                             AS subjects,
         COUNT(DISTINCT predicate)::text                           AS predicates
       FROM kg_triples`
    );

    const contradictions = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM (
         SELECT subject, predicate
         FROM kg_triples
         WHERE valid_to IS NULL
         GROUP BY subject, predicate
         HAVING COUNT(*) > 1
       ) c`
    );

    const row = totals.rows[0] ?? {};
    console.log();
    console.log(header("  PAI KG Stats"));
    console.log();
    console.log(`  ${bold("Total triples:")}        ${row.total ?? "0"}`);
    console.log(`  ${bold("Currently valid:")}      ${row.valid ?? "0"}`);
    console.log(`  ${bold("Invalidated:")}          ${row.invalidated ?? "0"}`);
    console.log(`  ${bold("Distinct subjects:")}    ${row.subjects ?? "0"}`);
    console.log(`  ${bold("Distinct predicates:")}  ${row.predicates ?? "0"}`);
    console.log(`  ${bold("Contradictions:")}       ${contradictions.rows[0]?.count ?? "0"}`);
    console.log();
  } finally {
    await close();
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
