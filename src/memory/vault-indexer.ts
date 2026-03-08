/**
 * PAI vault indexer — compatibility re-export.
 *
 * This file is the public entry point for "memory/vault-indexer" imports.
 * All implementation has moved to the vault/ subdirectory.
 */

export type { VaultFile, InodeGroup, ParsedLink, VaultIndexResult } from "./vault/types.js";
export { walkVaultMdFiles } from "./vault/walk.js";
export { deduplicateByInode } from "./vault/deduplicate.js";
export { parseLinks, parseWikilinks } from "./vault/parse-links.js";
export { buildNameIndex } from "./vault/name-index.js";
export { resolveWikilink } from "./vault/resolve.js";
export { indexVault } from "./vault/indexer.js";
