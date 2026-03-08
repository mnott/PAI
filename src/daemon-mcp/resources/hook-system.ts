export const hookSystem = {
  name: "hook-system",
  uri: "pai://hook-system",
  description: "Hook system reference — event-driven automation infrastructure",
  content: `# Hook System

Event-Driven Automation Infrastructure.

## Available Hook Types

| Event | When | Primary Use |
|-------|------|-------------|
| SessionStart | Session begins | Load PAI context |
| SessionEnd | Session terminates | Generate summaries |
| UserPromptSubmit | User submits prompt | Update tab titles |
| Stop | Main agent completes | Voice notifications, history capture |
| SubagentStop | Subagent completes | Agent-specific voice, history |
| PreToolUse | Before any tool | Analytics |
| PostToolUse | After any tool | Capture outputs, metrics |
| PreCompact | Before context compaction | Preserve state |

## Voice Notification Pattern

\`\`\`typescript
const payload = {
  title: 'PAI',
  message: completionMessage,
  voice_enabled: true,
  voice_id: 'YOUR_VOICE_ID'
};
await fetch('http://localhost:8888/notify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});
\`\`\`

## Hook Development Rules

1. Fast execution — hooks must complete in < 500ms
2. Graceful failure — always wrap in try/catch, always exit 0
3. Non-blocking — use background processes for slow work
4. Never block Claude Code

## Adding a Hook

1. Create hook script at \${PAI_DIR}/Hooks/my-hook.ts
2. Make executable: chmod +x
3. Add to settings.json under "hooks"
4. Restart Claude Code

Configuration file: \${PAI_DIR}/settings.json
`,
};
