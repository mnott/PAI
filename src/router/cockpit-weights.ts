import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expandHome } from "../workers/config.js";
import { resolveModelPath, type LocalTier } from "../workers/local-tiers.js";

/** Strata server-config args whose value is model data (a file or a directory of files). */
const STRATA_WEIGHT_FLAGS = new Set(["--pack", "--native", "--mtp"]);

function pathBytes(p: string, depth = 0): number {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  if (depth > 4) return 0;
  return readdirSync(p).reduce((a, e) => a + pathBytes(join(p, e), depth + 1), 0);
}

/** The files a tier's model is read from: the model path (vllm-mlx, script) or the weight args of the Strata config. */
function weightPaths(t: LocalTier): string[] {
  if (t.config) {
    const args = (JSON.parse(readFileSync(t.config, "utf8")) as { args?: unknown }).args;
    if (!Array.isArray(args)) return [];
    return args.flatMap((a, i) => (typeof args[i - 1] === "string" && STRATA_WEIGHT_FLAGS.has(args[i - 1] as string) && typeof a === "string" ? [a] : []));
  }
  if (t.start) {
    // script engine: the model path is the argument of `serve` in the start script
    const m = /\bserve(?:\s|\\)+(~?\/\S+)/.exec(readFileSync(t.start, "utf8"));
    return m ? [resolveModelPath(expandHome(m[1]!))] : [];
  }
  return t.model ? [resolveModelPath(t.model)] : [];
}

const cache = new Map<string, number>();

/** Weight size on disk of a tier's model, bytes; undefined when it cannot be read. Computed once per model file, cached. */
export function weightsBytes(t: LocalTier): number | undefined {
  const key = `${t.engine}:${t.config ?? t.start ?? t.model}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const paths = weightPaths(t);
    if (!paths.length) return undefined;
    const n = paths.reduce((a, p) => a + pathBytes(p), 0);
    if (n > 0) cache.set(key, n);
    return n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
