export const consolidate = {
  description:
    "Consolidate and clean up session notes — merge duplicates, fix titles, renumber sequentially",
  content: `## Consolidate Skill

USE WHEN user says 'consolidate notes', 'clean up notes', 'merge duplicate notes', 'fix session notes', 'deduplicate notes', '/consolidate', OR notes directory has duplicates or bad titles.

### What This Skill Does

Cleans up a project's session notes directory by:
1. Finding duplicate/superseded notes (same topic, different compaction snapshots)
2. Keeping the most complete version of each topic
3. Fixing garbage titles (renaming files and H1 headings)
4. Renumbering sequentially (0001, 0002, 0003...)
5. Optionally committing the cleanup

### Arguments

- No args: consolidate current project
- \`--project <slug>\`: consolidate a specific project
- \`--dry-run\`: show what would change without modifying files

### Workflow

**Step 1: Find the notes directory**
Use \`pai project detect\` to find the current project, then locate \`Notes/YYYY/MM/\` for the current month.

**Step 2: Inventory all notes**
List all .md files in the month directory. For each note, read:
- Filename (number, date, title)
- H1 heading inside the file
- Line count (proxy for completeness)
- First 20 lines (to understand the topic)

**Step 3: Group by topic**
Group notes that cover the same topic. Two notes are "same topic" if:
- Their filenames are identical (except the number)
- OR their H1 titles share >50% word overlap (Jaccard similarity)
- OR one is a strict subset of the other (shorter note's content is contained in the longer one)

**Step 4: For each group, keep the best**
- Keep the note with the most lines (most complete)
- Delete the others
- If the kept note has a bad title (garbage from user messages, too long, generic), rename it based on the H1 or the Focus/Work Done section

**Step 5: Renumber sequentially**
After deduplication, renumber all remaining notes: 0001, 0002, 0003...
Preserve the date and title in the filename.

**Step 6: Fix H1 headings**
Ensure each note's H1 matches its filename title and number.

**Step 7: Report and optionally commit**
Show what was done:
- Notes deleted (with reason)
- Notes renamed (old → new)
- Notes renumbered
Then ask if the user wants to commit: \`git add Notes/ && git commit -m "docs: consolidate session notes"\`

### Title Quality Rules

A title is "garbage" if it:
- Quotes a user message verbatim (conversational tone, starts with lowercase)
- Contains \`[object Object]\`, hex hashes, \`task-notification\`
- Is longer than 80 characters
- Is generic: "New Session", "Continued Session", "Session N"

Fix by reading the note's ## Work Done or **Focus:** line and deriving a descriptive title.

### Safety

- NEVER delete a note that is the ONLY one for its topic
- NEVER delete notes from previous months (only consolidate current month)
- Show the plan before executing (unless --force)
- Always preserve the most complete version
`,
};
