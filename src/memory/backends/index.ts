/**
 * Backend registry: config → backend, plus discovery.
 *
 * Detection order is speed order: ollama (Metal GPU) first, then
 * transformers-cpu. Add an "http" backend (e.g. MLX server) by implementing
 * EmbeddingBackend and adding a case to createBackend() and a probe to
 * detectBackends().
 */

import { loadConfig, type PaiDaemonConfig } from "../../daemon/config.js";
import type { EmbeddingBackend } from "./types.js";
import { TRANSFORMERS_ID, createTransformersBackend } from "./transformers-cpu.js";
import { OLLAMA_ID, OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL, createOllamaBackend, probeOllama } from "./ollama.js";
import { ollamaBinaryPath } from "./ollama-provision.js";

export const BACKEND_IDS = [OLLAMA_ID, TRANSFORMERS_ID] as const;
export { OLLAMA_ID, TRANSFORMERS_ID, OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL };

export function createBackend(
  id: string,
  cfg: Pick<PaiDaemonConfig, "embedding" | "embeddingModel"> = loadConfig(),
  modelOverride?: string,
): EmbeddingBackend {
  switch (id) {
    case OLLAMA_ID:
      return createOllamaBackend({
        baseUrl: cfg.embedding?.ollama?.baseUrl,
        model: modelOverride ?? cfg.embedding?.model ?? OLLAMA_DEFAULT_MODEL,
      });
    case TRANSFORMERS_ID:
      return createTransformersBackend(cfg.embeddingModel || "Snowflake/snowflake-arctic-embed-m-v1.5");
    default:
      throw new Error(`Unknown embedding backend "${id}". Known: ${BACKEND_IDS.join(", ")}`);
  }
}

export function getConfiguredBackend(cfg: PaiDaemonConfig = loadConfig()): EmbeddingBackend {
  return createBackend(cfg.embedding?.backend || TRANSFORMERS_ID, cfg);
}

export interface Detection {
  id: string;
  ok: boolean;
  reason: string;
  /** Model missing on a reachable server: `pai memory backend provision ollama` fixes it. */
  provisionable?: boolean;
}

export async function detectBackends(
  cfg: Pick<PaiDaemonConfig, "embedding" | "embeddingModel"> = loadConfig(),
  deps: { fetch?: typeof fetch; ollamaBinary?: () => string | null } = {},
): Promise<{ results: Detection[]; recommended: string | null }> {
  const ollama = createBackend(OLLAMA_ID, cfg) as ReturnType<typeof createOllamaBackend>;
  const baseUrl = cfg.embedding?.ollama?.baseUrl ?? OLLAMA_DEFAULT_URL;
  const p = await probeOllama(baseUrl, ollama.model, deps.fetch);
  const results: Detection[] = [];
  if (p.state === "ready") results.push({ id: OLLAMA_ID, ok: true, reason: p.detail });
  else if (p.state === "model-missing") {
    results.push({ id: OLLAMA_ID, ok: false, provisionable: true, reason: `${p.detail}; run \`pai memory backend provision ollama\`` });
  } else if ((deps.ollamaBinary ?? ollamaBinaryPath)()) {
    results.push({ id: OLLAMA_ID, ok: false, reason: `${p.detail}; ollama is installed, start it with \`ollama serve\`` });
  } else {
    results.push({ id: OLLAMA_ID, ok: false, reason: `${p.detail}; ollama is not installed` });
  }

  const t = await createBackend(TRANSFORMERS_ID, cfg).available();
  results.push({ id: TRANSFORMERS_ID, ...t });

  return { results, recommended: results.find((r) => r.ok)?.id ?? null };
}
