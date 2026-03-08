export const journal = {
  description: "Create, read, or search personal journal entries",
  content: `## Journal Skill

USE WHEN user says 'journal', 'note to self', 'capture this thought', 'journal entry', 'I want to write down', 'reflect on', 'yaja', '/journal', OR wants to record a freeform observation, insight, or personal note.

### Commands

| Command | Action |
|---------|--------|
| /journal | Create new entry |
| /journal read | Read today's entries |
| /journal search <query> | Search past entries |

### Storage

\`\${PAI_DIR}/Journal/YYYY/MM/YYYY-MM-DD.md\` — one file per day, entries appended with \`---\` separators.

### Entry Format

\`**HH:MM** — [content]\\n\\n#tags\`

### Auto-Tagging

Active project → \`#project-name\`, work → \`#work\`, mood → \`#reflection\`, idea → \`#idea\`, person → \`#people\`.

### Rules

Append-only. Never edit or delete existing entries. Preserve the user's voice — do not paraphrase. Voice entries via WhatsApp: clean up filler words, confirm with \`whatsapp_tts\`.`,
};
