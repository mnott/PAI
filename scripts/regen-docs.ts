/**
 * Regenerate docs/commands straight from the TypeScript command definitions (no build needed).
 * Run by the merge gate (`pai worker merge`) on the merged tree so generated pages never drift.
 * Same renderer as `pai doc --dir`, which `npm run build` uses.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS } from "../src/cli/registry.js";
import { renderPages, writePages } from "../src/cli/docgen.js";

const docs = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "commands");
writePages(docs, renderPages(GROUPS, join(docs, "_examples")));
