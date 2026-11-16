/** `pai models chat <model>`: a small REPL against a running local model's Anthropic Messages endpoint. */

import { createInterface } from "node:readline";

export interface ChatMsg { role: "user" | "assistant"; content: string }

/** ~4 chars per token. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Drop the oldest turns until the history fits `contextTokens` minus the reply
 * budget. Always keeps the last message, and the history starts on a user turn.
 */
export function trimHistory(history: ChatMsg[], contextTokens: number, reserveTokens: number): ChatMsg[] {
  const budget = Math.max(1, contextTokens - reserveTokens);
  const out = history.slice();
  const total = () => out.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
  while (out.length > 1 && total() > budget) out.shift();
  while (out.length > 1 && out[0].role !== "user") out.shift();
  return out;
}

/** Collect text deltas from an Anthropic SSE body. */
export async function* sseText(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(line.slice(5)) as { type?: string; delta?: { text?: string } };
        if (ev.type === "content_block_delta" && ev.delta?.text) yield ev.delta.text;
      } catch { /* ignore non-JSON */ }
    }
  }
}

export interface ChatTarget { baseUrl: string; model: string; contextTokens: number; maxTokens: number }

export async function runChat(t: ChatTarget): Promise<void> {
  const url = t.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/messages";
  let history: ChatMsg[] = [];
  process.stdout.write(`chatting with ${t.model} at ${url} (context ${t.contextTokens} tokens; /reset clears, /quit exits)\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "/quit" || line === "/exit") break;
    if (line === "/reset") { history = []; process.stdout.write("history cleared\n"); rl.prompt(); continue; }
    if (!line) { rl.prompt(); continue; }
    history.push({ role: "user", content: line });
    history = trimHistory(history, t.contextTokens, t.maxTokens);
    let reply = "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: t.model, max_tokens: t.maxTokens, stream: true, messages: history }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      for await (const d of sseText(res.body)) { reply += d; process.stdout.write(d); }
      process.stdout.write("\n");
      history.push({ role: "assistant", content: reply });
    } catch (e) {
      process.stdout.write(`error: ${(e as Error).message}\n`);
      history.pop();
    }
    rl.prompt();
  }
  rl.close();
}
