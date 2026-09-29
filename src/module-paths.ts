/**
 * module-paths.ts — locate a file relative to the package root from a running module.
 *
 * tsdown bundles shared code into chunks emitted directly under dist/ (e.g.
 * dist/program-*.mjs) rather than always alongside the entry that needs them
 * (dist/cli/index.mjs, dist/daemon/index.mjs, ...). A fixed "../daemon/index.mjs"
 * relative to import.meta.url assumes one specific chunk depth and silently
 * resolves to the wrong file — or a file under the source tree instead of
 * dist — whenever the bundler's chunking changes. Walking up from the running
 * module's own directory until `dir/rel` exists is depth-independent, and works
 * whether `rel` lives under dist/ (built entries) or is a sibling of dist/ at
 * the package root (files excluded from the bundle, like docker/migrate-sqlite.ts).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve `rel` by walking up from the directory containing `moduleUrl`,
 * returning the first `dir/rel` that exists on disk.
 *
 * Throws rather than returning a guessed path, so a caller writing a service
 * file or spawning a process fails loudly instead of pointing at nothing.
 */
export function resolveFromModule(moduleUrl: string, rel: string, maxLevels = 8): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < maxLevels; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate "${rel}" above ${dirname(fileURLToPath(moduleUrl))} — is the project built? (bun run build)`);
}
