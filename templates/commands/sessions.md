The user is asking about sessions or wants to manage their work across projects.

Their request: $ARGUMENTS

## How to Handle This

**If they said a project name** (like "pai", "kioskpilot", "work on pai"):
→ Run `pai "<project>" --dry-run` to see which session or project matches, then `pai "<project>"` to open it, and read that project's TODO.md to show pending work.

**If they said "list" or "show":**
→ Run `pai session active` first, then `pai session list`. For projects run `pai project list` (`pai project list --all` includes cold ones).

**If they said "search" + keyword:**
→ There is no CLI search command. Call the PAI MCP tools `memory_search` (keyword) and `session_list` to find matching sessions.

**If they said "open" + project:**
→ Run `pai open "<project>"`.

**If they said "info" + project:**
→ Run `pai notes <project>` for its session notes, and `pai project list` for the registry entry.

**If they said "consolidate" or "bring together":**
→ Search for matching sessions, read them, create a consolidated view.

**If they said "where" or "status":**
→ Run `pai session active`. Note routing has no CLI command; call the PAI MCP tool `session_route` to see which project the working directory belongs to.

**If they said "name":**
→ Run `pai rename <id> "<name>"` (ids come from `pai session list`).
