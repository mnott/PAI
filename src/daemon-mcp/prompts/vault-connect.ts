export const vaultConnect = {
  description: "Find connections between two topics in the Obsidian vault",
  content: `## VaultConnect Skill

USE WHEN user says 'connect X and Y', 'how does X relate to Y', 'find path between', 'bridge topics', '/vault-connect', OR asks how two ideas are connected in the vault.

Finds connections between two topics via the wikilink graph: direct links → 1-hop bridges → 2-hop paths. If no path found, offers to create a bridge note.`,
};
