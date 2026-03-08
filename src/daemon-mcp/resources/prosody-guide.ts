export const prosodyGuide = {
  name: "prosody-guide",
  uri: "pai://prosody-guide",
  description: "Voice prosody system — emotional markers and markdown pacing",
  content: `# Voice Prosody System

Controls emotional delivery and pacing across PAI agents.

## Emotional Intelligence Markers

| Marker | When to Use |
|--------|-------------|
| [excited] | Breakthroughs, discoveries, exciting results |
| [success] | Completions, wins, achievements |
| [caution] | Warnings, partial success, needs review |
| [urgent] | Critical issues, immediate action needed |

## Markdown Prosody

- **bold** — Emphasize key words (Found the **actual** bug)
- ... — Dramatic pause (Wait... I found something)
- -- — Thoughtful break (Complete -- all systems operational)
- ! — Energy and excitement

## Agent Archetypes

- Enthusiasts (fast, excited): More ellipses, exclamations, [excited] marker
- Professionals (balanced): Emphasis on actions, measured pauses, [success] marker
- Analysts (confident): Bold findings, authoritative, minimal markers
- Wise Leaders (deliberate): Em-dashes, minimal exclamations, measured

## COMPLETED Line Format

\`\`\`
COMPLETED: [AGENT:type] [optional marker] message with **emphasis**... and pauses!
\`\`\`

Maximum 12 words. End with punctuation.
`,
};
