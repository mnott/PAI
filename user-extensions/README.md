# PAI User Extensions

This directory is your personal extension point for PAI. Files here are gitignored
and will never be overwritten by PAI updates.

## Adding Custom Skills

Create a skill directory with a SKILL.md file:

```
user-extensions/skills/MySkill/SKILL.md
```

SKILL.md format:

```markdown
---
name: MySkill
description: "What the skill does. USE WHEN user says 'trigger phrase'."
---

## My Skill Instructions

Your skill content here...
```

After creating, run `bun run build` or `pai setup` to symlink it into
`~/.claude/skills/` where Claude Code discovers it.

## Adding Custom Hooks

Create a TypeScript or shell hook:

```
user-extensions/hooks/my-hook.ts
user-extensions/hooks/my-hook.sh
```

TypeScript hooks are compiled during `bun run build` and deployed to
`~/.claude/Hooks/`. Shell hooks are symlinked directly.

Hook input format (stdin JSON):
```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "...",
  "hook_event_name": "SessionStart|PreToolUse|PostToolUse|Stop|..."
}
```

After creating, register in `~/.claude/settings.json` under the appropriate
hook event, or run `pai setup` to auto-register.

## Adding Custom MCP Prompts

Create a prompt file in the custom prompts directory:

```
src/daemon-mcp/prompts/custom/my-prompt.ts
```

Format:
```typescript
export const myPrompt = {
  description: "What the prompt does",
  content: `## My Prompt

USE WHEN user says 'trigger phrase'...

### Instructions
Your prompt content here...`,
};
```

Run `bun run build` to generate the skill stub and symlink.

## Directory Structure

```
user-extensions/
├── hooks/          # Custom hook scripts (.ts or .sh)
│   └── .gitkeep
├── skills/         # Custom skill directories (each with SKILL.md)
│   └── .gitkeep
└── README.md       # This file
```
