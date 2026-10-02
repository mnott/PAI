// One-off, resumable: embed all pai_chunks via Ollama (GPU) into pai_chunks.embedding_ollama.
// Usage: node scripts/embed-ollama-job.mjs [--limit N] [--batch 64]
// Never touches the `embedding` column; no index is built here (HNSW comes at the backend switch).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import YAML from "yaml";
import { AutoTokenizer } from "@huggingface/transformers";

const MODEL = "arctic-m15-f16";
const BACKEND = "ollama-f16";
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MAX_TOKENS = 510; // model limit 512 minus CLS/SEP
const PAGE = 512;
const RETRY_BUDGET_MS = 30 * 60_000;

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const LIMIT = arg("limit", Infinity);
const BATCH = arg("batch", 64);

const cfg = YAML.parse(readFileSync(join(homedir(), ".claude", "pai", "config.yaml"), "utf8"));
const connectionString = cfg?.postgres?.connectionString;
if (!connectionString) throw new Error("postgres.connectionString missing in ~/.claude/pai/config.yaml");

const pool = new pg.Pool({ connectionString, max: 2 });
pool.on("error", () => {}); // idle-client errors surface on the next query and are retried
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRANSIENT_PG = /^(08|53|57P0|40001|40P01)/; // connection, resources, admin shutdown, serialization
const TRANSIENT_NET = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|timeout|terminated|Connection|fetch failed|socket/i;
const isTransient = (e) => e.transient || TRANSIENT_PG.test(e.code ?? "") || TRANSIENT_NET.test(`${e.code ?? ""} ${e.message}`);

async function retry(label, fn) {
  const t0 = Date.now();
  for (let delay = 2000; ; delay = Math.min(delay * 2, 60_000)) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e)) throw new Error(`${label}: non-transient failure: ${e.message}`);
      if (Date.now() - t0 > RETRY_BUDGET_MS) throw new Error(`${label}: still failing after 30 min: ${e.message}`);
      console.error(`${label}: transient (${e.message}); retry in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

async function embed(texts) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) {
    const err = new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.transient = res.status >= 500 || res.status === 429;
    throw err;
  }
  const { embeddings } = await res.json();
  if (embeddings?.length !== texts.length) throw new Error(`ollama returned ${embeddings?.length} vectors for ${texts.length} inputs`);
  for (const v of embeddings) {
    const norm = Math.hypot(...v);
    if (v.length !== 768 || Math.abs(norm - 1) > 0.01) throw new Error(`bad vector: dims=${v.length} norm=${norm}`);
  }
  return embeddings;
}

// Fails fast (non-transient) if the model is missing or the daemon is down for good.
async function migrate() {
  await pool.query("ALTER TABLE pai_chunks ADD COLUMN IF NOT EXISTS embedding_ollama vector(768)");
  await pool.query(`CREATE TABLE IF NOT EXISTS pai_embedding_jobs (
    column_name text PRIMARY KEY, model text NOT NULL, backend text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(
    "INSERT INTO pai_embedding_jobs (column_name, model, backend) VALUES ('embedding_ollama', $1, $2) ON CONFLICT DO NOTHING",
    [MODEL, BACKEND],
  );
}

const tokenizer = await AutoTokenizer.from_pretrained("Snowflake/snowflake-arctic-embed-m-v1.5");
let truncated = 0;
function truncate(text) {
  const ids = tokenizer.encode(text, { add_special_tokens: false });
  if (ids.length <= MAX_TOKENS) return text;
  truncated++;
  return tokenizer.decode(ids.slice(0, MAX_TOKENS), { skip_special_tokens: true });
}

await retry("migrate", migrate);
console.log(`migration ok: pai_chunks.embedding_ollama vector(768), job ${MODEL}/${BACKEND}`);

const total = Number((await retry("count", () => pool.query("SELECT count(*) FROM pai_chunks"))).rows[0].count);
const remaining0 = Number((await retry("count", () => pool.query("SELECT count(*) FROM pai_chunks WHERE embedding_ollama IS NULL"))).rows[0].count);
let done = total - remaining0;
let processed = 0;
console.log(`total=${total} already_done=${done} remaining=${remaining0}`);

const samples = []; // [time, processed] for a moving average
let lastLog = Date.now();
const report = (force) => {
  const now = Date.now();
  samples.push([now, processed]);
  while (samples.length > 1 && now - samples[0][0] > 120_000) samples.shift();
  if (!force && now - lastLog < 30_000) return;
  lastLog = now;
  const [t0, p0] = samples[0];
  const rate = now > t0 ? ((processed - p0) / (now - t0)) * 1000 : 0;
  const eta = rate > 0 ? Math.round((total - done) / rate) : NaN;
  console.log(`${done}/${total} done, ${rate.toFixed(1)} chunks/s, ETA ${Number.isNaN(eta) ? "?" : `${Math.floor(eta / 3600)}h${Math.floor((eta % 3600) / 60)}m`}, truncated ${truncated}`);
};

let lastId = "";
outer: while (processed < LIMIT) {
  const { rows } = await retry("select", () =>
    pool.query("SELECT id, text FROM pai_chunks WHERE id > $1 AND embedding_ollama IS NULL ORDER BY id LIMIT $2", [lastId, PAGE]));
  if (!rows.length) break;
  lastId = rows[rows.length - 1].id;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, Math.min(i + BATCH, i + LIMIT - processed));
    if (!batch.length) break outer;
    const texts = batch.map((r) => truncate(r.text));
    const vecs = await retry("embed", () => embed(texts));
    await retry("update", () =>
      pool.query(
        `UPDATE pai_chunks c SET embedding_ollama = v.e::vector
         FROM unnest($1::text[], $2::text[]) AS v(id, e) WHERE c.id = v.id`,
        [batch.map((r) => r.id), vecs.map((v) => `[${v.join(",")}]`)],
      ));
    processed += batch.length;
    done += batch.length;
    report(false);
  }
}
report(true);
console.log(`finished: ${processed} chunks this run, ${done}/${total} total`);
await pool.end();
