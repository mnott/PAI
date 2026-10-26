import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Append the standard bun install dir (`<home>/.bun/bin`) to env.PATH when it
 * exists and PATH does not already carry it. Hooks and hook tests spawn `bun`,
 * and a worker's environment frequently lacks that dir (2026-10-26: 45-68
 * spurious hook-test failures). Appending keeps any bun already on PATH first.
 */
export function withBunOnPath(env: NodeJS.ProcessEnv, home: string, exists: (p: string) => boolean = existsSync): NodeJS.ProcessEnv {
  if (!home) return env;
  const dir = join(home, ".bun", "bin");
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (parts.includes(dir) || !exists(dir)) return env;
  env.PATH = [...parts, dir].join(delimiter);
  return env;
}
