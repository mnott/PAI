# PAI Session Lifecycle Hooks

Shell scripts that wire Claude Code session events into the PAI registry.

## Hooks

### pre-compact.sh

Called by Claude Code **before context compaction** (when the context window is compressed).

What it does:
- Detects the current project via `pai project detect`
- Finds the latest open session in the registry
- Marks the session status as `compacted`
- Writes a record to `compaction_log`
- Triggers `pai obsidian sync` to update the vault

### session-stop.sh

Called by Claude Code **when a session ends**.

What it does:
- Detects the current project via `pai project detect`
- Finds the latest open or compacted session
- Marks it as `completed` and sets `closed_at`
- Runs `pai session slug <project> latest --apply` to auto-rename the session note
- Triggers `pai obsidian sync`

## Installation

Copy or symlink the scripts into `~/.claude/Hooks/`:

```bash
cp src/hooks/pre-compact.sh ~/.claude/Hooks/pai-pre-compact.sh
cp src/hooks/session-stop.sh ~/.claude/Hooks/pai-session-stop.sh
chmod +x ~/.claude/Hooks/pai-pre-compact.sh
chmod +x ~/.claude/Hooks/pai-session-stop.sh
```

Or symlink for live updates:

```bash
ln -sf "$(pwd)/src/hooks/pre-compact.sh" ~/.claude/Hooks/pai-pre-compact.sh
ln -sf "$(pwd)/src/hooks/session-stop.sh" ~/.claude/Hooks/pai-session-stop.sh
```

## Wiring into Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/YOUR_USERNAME/.claude/Hooks/pai-pre-compact.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/YOUR_USERNAME/.claude/Hooks/pai-session-stop.sh"
          }
        ]
      }
    ]
  }
}
```

Replace `YOUR_USERNAME` with your actual username.

## Safety

Both hooks are designed to be completely non-disruptive:
- They always exit with code 0
- They never use `set -e`
- Every SQLite and CLI call is guarded with `|| true`
- If `pai` is not installed, the hook exits immediately
- If the current directory is not a registered project, the hook exits immediately
