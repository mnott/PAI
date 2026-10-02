// Bulk re-embed of pai_chunks.embedding through Ollama (GPU), without HNSW write amplification.
// Run with bun (imports TypeScript from src/):
//   bun run scripts/embed-ollama-job.mjs [--phase prepare|carry|embed|finish] [--limit N]
//        [--concurrency 2] [--batch 64] [--status]
// No --phase = all phases in order (finish runs only once embed has covered every row).
// Job state lives in pai_embedding_jobs (row column_name = JOB). Every phase is idempotent and resumable.
// Phases: 1 prepare (drop HNSW, saving its definition) -> 2 carry (embedding_ollama -> embedding, drop column)
//         -> 3 embed (keyset by id, one UPDATE per batch, cursor in the same statement)
//         -> 4 finish (recreate HNSW, ANALYZE, record binding).
// Never writes config; never VACUUM FULL.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import YAML from "yaml";
import { createOllamaBackend } from "../src/memory/backends/ollama.ts";
import { retryTransient } from "../src/memory/indexer/retry.ts";
import { toBatches, recreateIndexSql, formatEta, vectorLiteral } from "../src/memory/embed-job.ts";

const JOB = "ollama-f16-reembed";
const MODEL = "arctic-m15-f16";
const INDEX = "idx_pai_chunks_embedding";
const PAGE = 512;

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const LIMIT = Number(arg("limit", Infinity));
const BATCH = Number(arg("batch", 64));
const CONCURRENCY = Number(arg("concurrency", 2));
const PHASE = arg("phase", "all");

const cfg = YAML.parse(readFileSync(join(homedir(), ".claude", "pai", "config.yaml"), "utf8"));
const connectionString = cfg?.postgres?.connectionString;
if (!connectionString) throw new Error("postgres.connectionString missing in ~/.claude/pai/config.yaml");
const pool = new pg.Pool({ connectionString, max: 3 });
pool.on("error", () => {}); // surfaces on the next query and is retried

const backend = createOllamaBackend({ model: MODEL });
// Ollama 5xx / 429 are transient; retryTransient recognises them by message.
const retry = (fn) =>
  retryTransient(async () => {
    try {
      return await fn();
    } catch (e) {
      if (/HTTP (5\d\d|429)/.test(e.message)) throw new Error(`connection terminated: ${e.message}`);
      throw e;
    }
  });
const q = (sql, params) => retry(() => pool.query(sql, params));

async function getState() {
  return (await q("SELECT state FROM pai_embedding_jobs WHERE column_name = $1", [JOB])).rows[0]?.state ?? null;
}
const patch = (obj) => q("UPDATE pai_embedding_jobs SET state = state || $2::jsonb WHERE column_name = $1", [JOB, JSON.stringify(obj)]);
const hasColumn = async () =>
  (await q("SELECT 1 FROM information_schema.columns WHERE table_name = 'pai_chunks' AND column_name = 'embedding_ollama'")).rowCount > 0;
const stamp = () => new Date().toISOString();

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS pai_embedding_jobs (
    column_name text PRIMARY KEY, model text NOT NULL, backend text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await q("ALTER TABLE pai_embedding_jobs ADD COLUMN IF NOT EXISTS state jsonb NOT NULL DEFAULT '{}'");
  await q("INSERT INTO pai_embedding_jobs (column_name, model, backend) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [JOB, MODEL, backend.id]);
}

async function prepare() {
  const s = await getState();
  if (s.prepared) return console.log(`prepare: already done (${s.startedAt})`);
  const avail = await backend.available();
  if (!avail.ok) throw new Error(`ollama not ready: ${avail.reason}`);
  const [probe] = await backend.embed(["prepare probe"]);
  if (probe.length !== 768) throw new Error(`model ${MODEL} returned ${probe.length} dims, expected 768`);
  console.log(`ollama ok: ${avail.reason}, dims ${probe.length}`);
  let indexDef = s.indexDef;
  if (!indexDef) {
    indexDef = (await q("SELECT indexdef FROM pg_indexes WHERE indexname = $1", [INDEX])).rows[0]?.indexdef;
    if (!indexDef) throw new Error(`index ${INDEX} not found and no saved definition`);
    recreateIndexSql(INDEX, indexDef); // validate before it is the only copy
    await patch({ indexDef }); // saved before the drop
  }
  const total = Number((await q("SELECT count(*) FROM pai_chunks")).rows[0].count);
  const upd = Number((await q("SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 'pai_chunks'")).rows[0].n_tup_upd);
  console.log(`saved index definition: ${indexDef}`);
  await q(`DROP INDEX IF EXISTS ${INDEX}`);
  await patch({ prepared: true, startedAt: stamp(), total, cursor: "", done: 0, carried: 0, model: MODEL, backend: backend.id, dims: 768, updAtStart: upd });
  console.log(`prepare done: HNSW dropped, total=${total}`);
}

async function carry() {
  let s = await getState();
  if (!s.prepared) throw new Error("run prepare first");
  if (s.carryDone) return console.log(`carry: already done (${s.carried} rows)`);
  if (await hasColumn()) {
    let after = s.carryCursor ?? "";
    for (;;) {
      const ids = (await q("SELECT id FROM pai_chunks WHERE id > $1 AND embedding_ollama IS NOT NULL ORDER BY id LIMIT $2", [after, PAGE])).rows.map((r) => r.id);
      if (!ids.length) break;
      after = ids[ids.length - 1];
      await q(
        `WITH u AS (UPDATE pai_chunks c SET embedding = c.embedding_ollama FROM unnest($1::text[]) AS v(id) WHERE c.id = v.id RETURNING 1)
         UPDATE pai_embedding_jobs SET state = state || jsonb_build_object('carryCursor', $2::text, 'carried', (state->>'carried')::int + $3::int) WHERE column_name = $4`,
        [ids, after, ids.length, JOB],
      );
    }
    s = await getState();
    // The old job embedded in id order, so the carried rows must be a prefix; embed resumes after it.
    const gap = Number((await q("SELECT count(*) FROM pai_chunks WHERE id <= $1 AND embedding_ollama IS NULL", [s.carryCursor ?? ""])).rows[0].count);
    if (s.carried && gap) throw new Error(`carried rows are not an id prefix (${gap} gaps); refusing to drop embedding_ollama`);
    await patch({ cursor: s.carryCursor ?? "", done: s.carried });
    await q("ALTER TABLE pai_chunks DROP COLUMN embedding_ollama");
  }
  s = await getState();
  await patch({ carryDone: true });
  console.log(`carry done: ${s.carried} rows copied into embedding, column embedding_ollama dropped`);
}

async function embedPhase() {
  let s = await getState();
  if (!s.carryDone) throw new Error("run carry first");
  const { total } = s;
  let { cursor, done } = s;
  let processed = 0;
  const t0 = Date.now();
  let lastLog = t0;
  let lastP = 0;
  let lastT = t0;
  console.log(`embed: ${done}/${total} done, cursor "${cursor}", concurrency ${CONCURRENCY}, batch ${BATCH}`);

  // Producer: pages by keyset from the cursor; the next page is fetched while batches embed.
  async function* batches() {
    let after = cursor;
    let left = LIMIT;
    let next = q("SELECT id, text FROM pai_chunks WHERE id > $1 ORDER BY id LIMIT $2", [after, PAGE]);
    while (left > 0) {
      const { rows } = await next;
      if (!rows.length) return;
      after = rows[rows.length - 1].id;
      next = q("SELECT id, text FROM pai_chunks WHERE id > $1 ORDER BY id LIMIT $2", [after, PAGE]);
      for (const b of toBatches(rows, BATCH, left)) {
        left -= b.length;
        yield b;
      }
    }
  }

  const inflight = []; // [batch, embedPromise] in cursor order; DB writes commit in this order
  const flush = async () => {
    const [b, p] = inflight.shift();
    const vecs = await p;
    const ids = b.map((r) => r.id);
    cursor = ids[ids.length - 1];
    await q(
      `WITH u AS (UPDATE pai_chunks c SET embedding = v.e::vector FROM unnest($1::text[], $2::text[]) AS v(id, e) WHERE c.id = v.id RETURNING 1)
       UPDATE pai_embedding_jobs SET state = state || jsonb_build_object('cursor', $3::text, 'done', (state->>'done')::int + $4::int) WHERE column_name = $5`,
      [ids, vecs.map(vectorLiteral), cursor, ids.length, JOB],
    );
    processed += ids.length;
    done += ids.length;
    const now = Date.now();
    if (now - lastLog >= 30_000) {
      const rate = ((processed - lastP) / (now - lastT)) * 1000;
      console.log(`${done}/${total} done, ${rate.toFixed(1)} chunks/s, ETA ${formatEta((total - done) / rate)}`);
      lastLog = now;
      lastP = processed;
      lastT = now;
    }
  };
  for await (const b of batches()) {
    const p = retry(() => backend.embed(b.map((r) => r.text)));
    p.catch(() => {}); // awaited in flush; avoid unhandled rejection while queued
    inflight.push([b, p]);
    if (inflight.length >= CONCURRENCY) await flush();
  }
  while (inflight.length) await flush();
  const secs = (Date.now() - t0) / 1000;
  console.log(`embed run: ${processed} chunks in ${secs.toFixed(0)}s = ${(processed / secs).toFixed(1)} chunks/s overall; ${done}/${total}`);
  if (processed < LIMIT) await patch({ embedDone: true });
}

async function finish() {
  const s = await getState();
  if (!s.embedDone) throw new Error("embed phase not complete");
  if (s.finished) return console.log(`finish: already done (${s.finishedAt})`);
  const sql = recreateIndexSql(INDEX, s.indexDef);
  console.log(`[${stamp()}] building HNSW: ${s.indexDef}`);
  const c = await pool.connect();
  const poll = setInterval(async () => {
    try {
      const r = await pool.query("SELECT phase, blocks_done, blocks_total, tuples_done, tuples_total FROM pg_stat_progress_create_index");
      if (r.rows[0]) console.log(`[${stamp()}] index build: ${JSON.stringify(r.rows[0])}`);
    } catch {}
  }, 30_000);
  try {
    await c.query("SET maintenance_work_mem = '2GB'");
    await c.query("SET max_parallel_maintenance_workers = 4");
    await c.query("SET statement_timeout = 0");
    await c.query(sql);
  } finally {
    clearInterval(poll);
    c.release();
  }
  console.log(`[${stamp()}] HNSW built; ANALYZE`);
  await q("ANALYZE pai_chunks");
  // Binding exactly as the backend reports; set via the storage layer (pg + pending-binding rules live there).
  const { getStorageBackend, closeStorage } = await import("../src/storage/factory.ts");
  const storage = await getStorageBackend();
  await storage.setEmbeddingBinding({ backend: backend.id, model: backend.model, dims: backend.dims });
  console.log(`binding set: ${backend.id} / ${backend.model} / ${backend.dims}`);
  await closeStorage();
  await patch({ finished: true, finishedAt: stamp() });
  console.log(`[${stamp()}] finish done`);
}

async function status() {
  const s = await getState();
  const col = await hasColumn();
  const idx = (await q("SELECT 1 FROM pg_indexes WHERE indexname = $1", [INDEX])).rowCount > 0;
  const st = (await q("SELECT n_tup_upd, n_tup_hot_upd, n_dead_tup FROM pg_stat_user_tables WHERE relname = 'pai_chunks'")).rows[0];
  console.log(JSON.stringify({ job: JOB, state: { ...s, indexDef: s?.indexDef ? "(saved)" : null }, embedding_ollama_column: col, hnsw_index_present: idx, pai_chunks_stats: st }, null, 2));
}

try {
  await init();
  if (flag("status")) await status();
  else {
    const run = (name, fn) => (PHASE === "all" || PHASE === name ? fn() : undefined);
    await run("prepare", prepare);
    await run("carry", carry);
    await run("embed", embedPhase);
    if (PHASE === "finish" || (PHASE === "all" && (await getState()).embedDone)) await finish();
  }
} finally {
  await pool.end();
}
