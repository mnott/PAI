/**
 * bench-sse-stall.ts — reproducible stall bench for the SSE forwarding path.
 *
 * A stub upstream streams one long tool_use (a Write with ~20 KB of content)
 * in 1-token chunks through a router built from this worktree on a free port.
 * Reports the worst event-loop delay (perf_hooks.monitorEventLoopDelay) over
 * the whole stream and the total synchronous time spent in the router while
 * the stream flows. Run it before and after the fix to compare; the
 * forwarded tool input must come out byte-identical to the stub's bytes.
 */

import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseWorkersConfig } from "../src/workers/config.js";
import { createRouter } from "../src/router/router.js";
import { claudeCodeToolsArray } from "../src/router/tool-args-schemas.js";
import { RulesStore } from "../src/router/tool-call-rules.js";

const CHUNKS = Number(process.env.CHUNKS ?? 400);

const CONTENT = "line of file content number 0123456789 abcdefghijklmnopqrstuvwxyz\n".repeat(600); // ~20 KB
const inputJson = JSON.stringify({ file_path: "/a/b/c.txt", content: CONTENT });

/** Split the tool input JSON into ~equal chunks, the way a local model dribbles it out. */
function chunksOf(s: string, n: number): string[] {
  const size = Math.max(4, Math.ceil(s.length / n));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

const CHUNK_TEXT = chunksOf(inputJson, CHUNKS);

const sse = (events: Array<[string, object]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const EVENTS = sse([
  ["message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 10, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "w1", name: "Write", input: {} } }],
  ...CHUNK_TEXT.map((c): [string, object] => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: c } }]),
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: CHUNK_TEXT.length } }],
  ["message_stop", { type: "message_stop" }],
]);

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

async function main(): Promise<void> {
  // stub upstream: answers /v1/messages with the SSE stream, one chunk per tick
  const up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const t = setInterval(() => {
        if (i >= CHUNK_TEXT.length + 5) {
          clearInterval(t);
          res.end();
          return;
        }
        // write one SSE event per tick (the events were pre-rendered above)
        const evs = EVENTS.split("\n\n");
        res.write(evs[i++] + "\n\n");
      }, 2);
      t.unref();
    });
  });
  const upPort = await listen(up);
  const prov = parseWorkersConfig({
    providers: { gyro: { baseUrl: `http://127.0.0.1:${upPort}`, models: { default: "gyro-m" }, toolParsing: "router" } },
  }).providers;
  const home = mkdtempSync(join(tmpdir(), "tcr-bench-"));
  const store = new RulesStore({ config: () => undefined, homeDir: () => home, log: () => undefined });
  const r = createRouter(() => prov, "http://127.0.0.1:1", () => undefined, undefined, undefined, {
    instances: () => [],
    toolCallRules: store,
  });
  const port = await listen(r);

  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  const t0 = performance.now();
  const out = await new Promise<string>((resolve, reject) => {
    const q = http.request({ port, host: "127.0.0.1", path: "/v1/messages", method: "POST", headers: { "x-pai-provider": "gyro" } }, (x) => {
      if (x.statusCode !== 200) return reject(new Error(`router answered ${x.statusCode}`));
      const bits: Buffer[] = [];
      x.on("data", (c) => bits.push(c));
      x.on("end", () => resolve(Buffer.concat(bits).toString()));
      x.on("error", reject);
    });
    q.end(JSON.stringify({ model: "gyro-m", stream: true, tools: claudeCodeToolsArray(), messages: [{ role: "user", content: "write the file" }] }));
  });
  const totalMs = performance.now() - t0;
  h.disable();

  // reassemble the forwarded tool input from the SSE the client saw
  let toolJson = "";
  let deltas = 0;
  for (const m of out.split("\n\n")) {
    const d = m.split("\n").find((l) => l.startsWith("data:"));
    if (!d) continue;
    try {
      const ev = JSON.parse(d.slice(5)) as { delta?: { type?: string; partial_json?: string } };
      if (ev.delta?.type === "input_json_delta" && typeof ev.delta.partial_json === "string") {
        deltas++;
        toolJson += ev.delta.partial_json;
      }
    } catch {
      /* ignore */
    }
  }
  console.log(`chunks=${CHUNK_TEXT.length} deltas=${deltas} toolBytes=${toolJson.length} receivedBytes=${out.length} total=${totalMs.toFixed(0)}ms loopDelayMax=${(h.max / 1e6).toFixed(1)}ms loopDelayMean=${(h.mean / 1e6).toFixed(2)}ms`);
  if (toolJson !== inputJson) {
    console.error("FORWARDED TOOL INPUT DIFFERS FROM THE STUB'S BYTES");
    process.exitCode = 1;
  }
  r.close();
  up.close();
}

void main();
