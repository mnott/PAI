/**
 * Shared types for the PAI vault indexer.
 */

export interface VaultFile {
  absPath: string;
  vaultRelPath: string;
  inode: number;
  device: number;
}

export interface InodeGroup {
  canonical: VaultFile;
  aliases: VaultFile[];
}

export interface ParsedLink {
  raw: string;
  alias: string | null;
  lineNumber: number;
  isEmbed: boolean;
  /** True when parsed from markdown `[text](path)` syntax (vs `[[wikilink]]`). */
  isMdLink?: boolean;
}

export interface VaultIndexResult {
  filesIndexed: number;
  chunksCreated: number;
  filesSkipped: number;
  aliasesRecorded: number;
  linksExtracted: number;
  deadLinksFound: number;
  orphansFound: number;
  elapsed: number;
}
