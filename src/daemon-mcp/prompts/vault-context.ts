export const vaultContext = {
  description: "Load Obsidian vault context for a morning briefing",
  content: `## VaultContext Skill

USE WHEN user says 'load vault context', 'brief me from Obsidian', 'morning briefing', '/vault-context', 'what am I working on', 'what\\'s in my vault'.

Reads: daily note → open TODOs → PAI index (active projects) → HOME.md (focus areas) → recent insights. Synthesizes into morning briefing with Suggested First Action.

All vault skills work with the vault configured in \`~/.config/pai/config.json\` (\`vaultPath\` key).`,
};
