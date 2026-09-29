# Auto-Compact Context Window

Claude Code can automatically compact your context window when it fills up, preventing session interruptions mid-task. PAI's statusline shows you at a glance whether auto-compact is active.

## Why the GUI setting doesn't work

Claude Code has an `autoCompactEnabled` setting in `~/.claude.json`, but it gets overwritten on every restart. Do not use it — changes don't survive.

## The durable approach: environment variable

Set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in your `~/.claude/settings.json` under the `env` block. This survives restarts, `/clear`, and Claude Code updates.

```json
{
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "80"
  }
}
```

The value is the context percentage at which compaction triggers. `80` means compact when the context window reaches 80% full. Restart Claude Code after saving.

## Statusline indicator

PAI's statusline shows the remaining context until auto-compact triggers as a percentage on line 3, along with your 5-hour and 7-day usage limits, daily pace indicator, and advisor mode label.

## Set it up with one prompt

Give Claude Code this prompt and it handles everything:

> Add `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set to `80` to the `env` block in `~/.claude/settings.json`. This enables durable auto-compact that survives restarts. Do not touch `~/.claude.json` — that file gets overwritten on startup. After saving, confirm the setting is in place and tell me to restart Claude Code.
