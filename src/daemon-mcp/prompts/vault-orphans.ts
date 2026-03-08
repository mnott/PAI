export const vaultOrphans = {
  description: "Find and reconnect orphaned notes with zero inbound links",
  content: `## VaultOrphans Skill

USE WHEN user says 'find orphans', 'orphaned notes', 'unlinked notes', 'vault orphans', '/vault-orphans', 'clean up vault graph', 'disconnected notes'.

Finds notes with zero inbound wikilinks. Groups by top-level folder. Excludes expected orphan folders (PAI/, Daily Notes/). For each orphan, suggests connections to existing notes and drafts specific wikilink text.`,
};
