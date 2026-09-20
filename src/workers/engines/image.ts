/**
 * engines/image.ts — the `engine: image` worker.
 *
 * No claude-code process, no worktree, no MCP: `pai worker run --capability
 * image` POSTs one OpenAI-compatible images-generations request straight to
 * the provider's `url` and writes the PNG it gets back. One request, no
 * retries beyond the fetch's own timeout — a caller that wants another try
 * just runs again.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveProviderKey, WorkersConfigError, type WorkerProvider } from "../config.js";

export interface ImageRunOptions {
  providerName: string;
  provider: WorkerProvider;
  model: string;
  prompt: string;
  /** Where the PNG is written; caller resolves the default path. */
  outPath: string;
  /** "WIDTHxHEIGHT", default 1024x1024. */
  size?: string;
  /** Default 120000 (2 minutes). */
  timeoutMs?: number;
}

export interface ImageRunResult {
  ok: true;
  path: string;
  model: string;
  provider: string;
  durationMs: number;
  bytes: number;
}

const DEFAULT_SIZE = "1024x1024";
export const DEFAULT_IMAGE_TIMEOUT_MS = 120_000;

interface ImagesGenerationsResponse {
  data?: { b64_json?: string }[];
}

/**
 * `POST {url}/images/generations` with `{model, prompt, size, n: 1,
 * response_format: "b64_json"}` and the provider's bearer token, decode the
 * base64 PNG it returns, and write it to `outPath`.
 */
export async function runImageCapability(opts: ImageRunOptions): Promise<ImageRunResult> {
  if (!opts.provider.baseUrl) {
    throw new WorkersConfigError(
      `provider "${opts.providerName}" (engine image) has no "url" configured — set one with: ` +
        `pai worker providers update ${opts.providerName} --base-url <url>`
    );
  }
  const token = resolveProviderKey(opts.provider);
  const url = `${opts.provider.baseUrl.replace(/\/+$/, "")}/images/generations`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        size: opts.size ?? DEFAULT_SIZE,
        n: 1,
        response_format: "b64_json",
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new WorkersConfigError(
        `provider "${opts.providerName}": image request timed out after ${timeoutMs}ms`
      );
    }
    throw new WorkersConfigError(
      `provider "${opts.providerName}": image request failed: ${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    throw new WorkersConfigError(
      `provider "${opts.providerName}": image request failed (${res.status}): ${text.slice(0, 500)}`
    );
  }
  let parsed: ImagesGenerationsResponse;
  try {
    parsed = JSON.parse(text) as ImagesGenerationsResponse;
  } catch {
    throw new WorkersConfigError(`provider "${opts.providerName}": image response was not JSON`);
  }
  const b64 = parsed.data?.[0]?.b64_json;
  if (!b64) {
    throw new WorkersConfigError(`provider "${opts.providerName}": image response had no data[0].b64_json`);
  }
  const bytes = Buffer.from(b64, "base64");
  mkdirSync(dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, bytes);
  return {
    ok: true,
    path: opts.outPath,
    model: opts.model,
    provider: opts.providerName,
    durationMs,
    bytes: bytes.length,
  };
}
