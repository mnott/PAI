/**
 * Ollama backend: POST {baseUrl}/api/embed, Metal GPU. Measured ~51 chunks/s
 * with an F16 GGUF of arctic-embed-m-v1.5 (vs ~8 for CPU q8), cosine 0.99999
 * against fp32 for inputs up to 510 tokens.
 *
 * Ollama cuts inputs over 510 real tokens differently from the model's own
 * truncation (cos ~0.45 vs fp32), so every text is cut to 510 tokens here
 * with the model's tokenizer before it is sent. Chunk boundaries in the
 * database are not touched.
 */

import type { EmbeddingBackend } from "./types.js";

export const OLLAMA_ID = "ollama-f16";
export const OLLAMA_DEFAULT_MODEL = "arctic-embed-m-v1.5-f16";
export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
export const TOKENIZER_MODEL = "Snowflake/snowflake-arctic-embed-m-v1.5";

const BATCH = 64;
const MAX_CONTENT_TOKENS = 510; // 512 minus [CLS] and [SEP]

export interface Tokenizer {
  encode(text: string): number[];
  decode(ids: number[]): string;
}

export interface OllamaDeps {
  fetch?: typeof fetch;
  tokenizer?: () => Promise<Tokenizer>;
  log?: (msg: string) => void;
}

async function loadTokenizer(): Promise<Tokenizer> {
  const { AutoTokenizer } = await import("@huggingface/transformers");
  const tok = await AutoTokenizer.from_pretrained(TOKENIZER_MODEL);
  return {
    encode: (t) => tok.encode(t) as number[],
    decode: (ids) => tok.decode(ids, { skip_special_tokens: true }),
  };
}

/**
 * Cut `text` to at most 510 content tokens (512 with specials). Returns the
 * text unchanged when it already fits.
 */
export function truncateToTokens(text: string, tok: Tokenizer): { text: string; truncated: boolean } {
  // A token is at least one character, so a short text cannot exceed the cap.
  if (text.length <= MAX_CONTENT_TOKENS) return { text, truncated: false };
  const ids = tok.encode(text);
  if (ids.length <= MAX_CONTENT_TOKENS + 2) return { text, truncated: false };
  let keep = MAX_CONTENT_TOKENS;
  let cut: string;
  // decode+re-encode can shift the count by a few tokens; shrink until it fits.
  do {
    cut = tok.decode(ids.slice(1, 1 + keep));
    keep -= 5;
  } while (tok.encode(cut).length > MAX_CONTENT_TOKENS + 2 && keep > 0);
  return { text: cut, truncated: true };
}

export type OllamaState = "ready" | "model-missing" | "server-down";

export async function probeOllama(
  baseUrl: string,
  model: string,
  f: typeof fetch = fetch,
): Promise<{ state: OllamaState; detail: string }> {
  let names: string[];
  try {
    const r = await f(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { state: "server-down", detail: `${baseUrl} answered HTTP ${r.status}` };
    names = ((await r.json()) as { models?: Array<{ name: string }> }).models?.map((m) => m.name) ?? [];
  } catch {
    return { state: "server-down", detail: `no Ollama server at ${baseUrl}` };
  }
  const present = names.some((n) => n === model || n === `${model}:latest`);
  return present
    ? { state: "ready", detail: `server at ${baseUrl}, model ${model} present` }
    : { state: "model-missing", detail: `server at ${baseUrl} reachable, model ${model} not present` };
}

export function createOllamaBackend(
  opts: { baseUrl?: string; model?: string } = {},
  deps: OllamaDeps = {},
): EmbeddingBackend {
  const baseUrl = (opts.baseUrl ?? OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
  const model = opts.model ?? OLLAMA_DEFAULT_MODEL;
  const f = deps.fetch ?? fetch;
  const log = deps.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const getTok = deps.tokenizer ?? loadTokenizer;
  let tok: Tokenizer | undefined;
  const dims = 768;

  async function post(input: string[]): Promise<number[][]> {
    let r: Response;
    try {
      r = await f(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input, keep_alive: "10m" }),
      });
    } catch (e) {
      // Surface the socket code so retryTransient treats a down server as transient.
      const code = (e as { cause?: { code?: string } }).cause?.code ?? "ECONNREFUSED";
      throw Object.assign(new Error(`Ollama unreachable at ${baseUrl} (${code})`), { code });
    }
    if (!r.ok) throw new Error(`Ollama /api/embed HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const body = (await r.json()) as { embeddings?: number[][] };
    if (!body.embeddings || body.embeddings.length !== input.length) {
      throw new Error(`Ollama returned ${body.embeddings?.length ?? 0} embeddings for ${input.length} inputs`);
    }
    return body.embeddings;
  }

  return {
    id: OLLAMA_ID,
    model,
    dims,
    maxTokens: 512,
    async available() {
      const p = await probeOllama(baseUrl, model, f);
      return { ok: p.state === "ready", reason: p.detail };
    },
    async embed(texts) {
      if (texts.length === 0) return [];
      tok ??= await getTok();
      let cutCount = 0;
      const prepared = texts.map((t) => {
        const r = truncateToTokens(t, tok!);
        if (r.truncated) cutCount++;
        return r.text;
      });
      if (cutCount > 0) log(`[pai-embed] ollama: truncated ${cutCount}/${texts.length} texts to ${MAX_CONTENT_TOKENS} tokens`);

      const out: Float32Array[] = [];
      for (let i = 0; i < prepared.length; i += BATCH) {
        for (const row of await post(prepared.slice(i, i + BATCH))) {
          if (row.length !== dims) throw new Error(`Ollama model ${model} returned ${row.length}-dim vectors, expected ${dims}`);
          const v = Float32Array.from(row);
          let n = 0;
          for (let k = 0; k < v.length; k++) n += v[k] * v[k];
          if (Math.abs(Math.sqrt(n) - 1) > 1e-3) throw new Error(`Ollama model ${model} returned non-normalized vectors (|v|=${Math.sqrt(n).toFixed(4)})`);
          out.push(v);
        }
      }
      return out;
    },
  };
}
