/**
 * PAI vault indexer — barrel re-export.
 *
 * Re-exports the full public API from the vault sub-modules.
 */

// Types
export type { VaultFile, InodeGroup, ParsedLink, VaultIndexResult } from "./types.js";

// Walk
export { walkVaultMdFiles } from "./walk.js";

// Deduplication
export { deduplicateByInode } from "./deduplicate.js";

// Link parsing
export { parseLinks, parseWikilinks } from "./parse-links.js";

// Name index
export { buildNameIndex } from "./name-index.js";

// Wikilink resolution
export { resolveWikilink } from "./resolve.js";

// Main orchestrator
export { indexVault } from "./indexer.js";
