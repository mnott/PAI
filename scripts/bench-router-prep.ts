import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseWorkersConfig } from "../src/workers/config.js";
import { prepare } from "../src/router/router.js";
import { fingerprint } from "../src/router/usage.js";

const providers = parseWorkersConfig({
  providers: { loc: { baseUrl: "http://127.0.0.1:8011", models: { default: "qwen3-coder-30b" } } },
}).providers;
function mk(tokens: number): Buffer {
  const messages: unknown[] = [];
  let i = 0, size = 0;
  while (size < tokens * 4) {
    const r = "x".repeat(1500) + i;
    messages.push({ role: "assistant", content: [{ type: "text", text: "step " + i }, { type: "tool_use", id: "t" + i, name: "Read", input: { file: "/a/b" + i } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: r, cache_control: { type: "ephemeral" } }] });
    size += r.length + 200; i++;
  }
  const tools = Array.from({ length: 30 }, (_, k) => ({ name: "tool" + k, description: "d".repeat(800), input_schema: { type: "object", properties: { a: { type: "string" } } } }));
  return Buffer.from(JSON.stringify({ model: "qwen3-coder-30b", system: [{ type: "text", text: "s".repeat(20000) }], tools, messages, stream: true }));
}
for (const tok of [50000, 150000]) {
  const raw = mk(tok);
  const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
  const ts: number[] = [];
  for (let n = 0; n < 20; n++) {
    const t = performance.now();
    const p = prepare("/v1/messages", {}, raw, providers);
    if (!p.ok) throw new Error(p.message);
    const parsed = process.env.AFTER ? (p as any).body ?? JSON.parse(p.up.body.toString("utf8")) : JSON.parse(p.up.body.toString("utf8"));
    fingerprint(parsed);
    ts.push(performance.now() - t);
    await new Promise((r) => setTimeout(r, 2));
  }
  h.disable();
  ts.sort((a, b) => a - b);
  console.log(`${tok} tok body=${(raw.length / 1024) | 0}KB sync median=${ts[10].toFixed(1)}ms max=${ts[19].toFixed(1)}ms loopDelayMax=${(h.max / 1e6).toFixed(1)}ms`);
}
