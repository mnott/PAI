// Benchmark embedding throughput: node scripts/bench-embed.mjs <dtype> <threads|0> <n> <batch,batch,...>
import { pipeline, env } from "@huggingface/transformers";
import { performance } from "node:perf_hooks";

const [dtype = "q8", threads = "0", n = "128", batches = "1,16,50,128"] = process.argv.slice(2);
const N = Number(n);
const words = "memory chunk session project index vector query note daemon worker branch commit build test config".split(" ");
const texts = Array.from({ length: N }, (_, i) =>
  Array.from({ length: 280 + (i * 7) % 80 }, (_, j) => words[(i * 31 + j * 17) % words.length] + (j % 9 === 0 ? "," : "")).join(" "));

const opts = { dtype };
if (Number(threads) > 0) opts.session_options = { intraOpNumThreads: Number(threads) };
const ex = await pipeline("feature-extraction", "Snowflake/snowflake-arctic-embed-m-v1.5", opts);
const tok = ex.tokenizer;
let t = performance.now();
const enc = tok(texts, { padding: true, truncation: true });
const tokMs = performance.now() - t;
console.log(JSON.stringify({ backend: env.backends?.onnx?.wasm ? "has-wasm-cfg" : "?", dtype, threads, tokenize_ms: Math.round(tokMs), seqlen: enc.input_ids.dims }));
await ex(texts.slice(0, 2), { pooling: "cls", normalize: true });
for (const b of batches.split(",").map(Number)) {
  const c0 = process.cpuUsage(); const t0 = performance.now();
  for (let i = 0; i < N; i += b) await ex(texts.slice(i, i + b), { pooling: "cls", normalize: true });
  const ms = performance.now() - t0; const c = process.cpuUsage(c0);
  console.log(JSON.stringify({ dtype, threads, batch: b, chunks_s: +(N / (ms / 1000)).toFixed(1), cpu_pct: Math.round(((c.user + c.system) / 1000 / ms) * 100) }));
}
