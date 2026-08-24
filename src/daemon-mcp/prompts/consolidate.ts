export const consolidate = {
  description:
    "Report duplicate session notes and fix bad titles. Collapses a group ONLY when one note provably contains the others; never deletes otherwise, and never renumbers",
  content: `## Consolidate Skill

USE WHEN user says 'consolidate notes', 'clean up notes', 'merge duplicate notes', 'fix session notes', 'deduplicate notes', '/consolidate', OR notes directory has duplicates or bad titles.

### What This Skill Does

Cleans up a project's session notes directory by:
1. Finding duplicate/superseded notes (same topic, different compaction snapshots)
2. Keeping the most complete version of each topic
3. Fixing garbage titles (renaming files and H1 headings)
4. Reporting number collisions — never reassigning numbers
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
Sort the group by length and test containment: if every shorter file's full
text appears inside the next longer one, the group nests — keep the longest.

If it does NOT nest, keep every file and report the group for a human decision.
Do not merge, do not pick, do not delete.

This step used to say "keep the note with the most lines (most complete), delete
the others". Longest and most-complete are different properties. Measured on a
real corpus of 407 notes: of the 31 multi-file groups, ZERO nested and 17
differed in body text — "keep the longest" would have deleted material existing
nowhere else. Title matches are not evidence either: 48 files there shared one
generated title, all distinct sessions.
- If the kept note has a bad title (garbage from user messages, too long, generic), rename it based on the H1 or the Focus/Work Done section

**Step 5: Do NOT renumber**
Numbers are identities, not positions — notes and handovers cite each other by
number, so reassigning silently repoints every reference. It is also the whole
of the diff churn: 407 files rewritten because the set changed by one. Mint a
number at creation and leave it. Gaps are fine. Report collisions; never shift.
Preserve the date and title in the filename.

**Step 6: Fix H1 headings**
Ensure each note's H1 matches its filename title and number.

**Step 7: Report and optionally commit**
Show what was done:
- Groups reported and left alone (the common case)
- Notes deleted (rare — only where containment was verified; name the file that
  now contains the deleted one)
- Notes renamed (old → new)
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
