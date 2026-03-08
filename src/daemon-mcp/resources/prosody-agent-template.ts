export const prosodyAgentTemplate = {
  name: "prosody-agent-template",
  uri: "pai://prosody-agent-template",
  description: "Template for adding prosody requirements to agent definitions",
  content: `# Agent Prosody Template

Universal prosody section to add to agent definition files.

## Voice Prosody Requirements

Your voice delivery is controlled by prosody markers in your COMPLETED lines.

### Emotional Intelligence Markers

- [excited] — Breakthroughs, discoveries, exciting results
- [success] — Completions, wins, achievements
- [caution] — Warnings, partial success, needs review
- [urgent] — Critical issues, immediate action needed

### Markdown Prosody

- **bold** — Emphasize key words
- ... — Dramatic pauses
- -- — Thoughtful breaks
- ! — Energy and excitement

### Quick Reference

\`\`\`
COMPLETED: [AGENT:your-type] [optional marker] message with **emphasis**... and pauses!
\`\`\`

Full Guide: fetch resource pai://prosody-guide
`,
};
