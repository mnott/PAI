/**
 * obsidian/sync.ts — shim for backward compatibility.
 * All implementations have moved to obsidian/sync/ sub-modules.
 */
export type { SyncStats } from "./sync/types.js";
export { syncVault } from "./sync/symlinks.js";
export { generateIndex, generateTopicPages, defaultVaultPath } from "./sync/generate.js";
export { generateMasterNotes, fixSessionTags } from "./sync/master.js";
