export const searchHistory = {
  description: "Search past sessions, history, and previous work by keyword",
  content: `## SearchHistory Skill

USE WHEN user says 'search history', 'find past', 'what did we do', 'when did we', OR asks about previous sessions, past work, or historical context.

### Search Commands

\`\`\`bash
# Keyword search across all history and project notes
rg -i -l "$QUERY" ~/.claude/History/ ~/.claude/projects/*/Notes/

# Recent files (last 7 days)
find ~/.claude/projects/*/Notes -name "*.md" -mtime -7 | xargs ls -lt | head -10

# Search prompts (what did I ask about X?)
rg -i '"prompt":.*KEYWORD' ~/.claude/History/raw-outputs/
\`\`\`

### Locations

| Content | Location |
|---------|----------|
| Session notes | \`~/.claude/projects/*/Notes/*.md\` |
| History sessions | \`~/.claude/History/sessions/YYYY-MM/\` |
| Learnings | \`~/.claude/History/Learnings/YYYY-MM/\` |
| Decisions | \`~/.claude/History/Decisions/YYYY-MM/\` |
| All prompts | \`~/.claude/History/raw-outputs/YYYY-MM/*_all-events.jsonl\` |`,
};
