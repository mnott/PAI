/**
 * session-summary-prompt.ts — Haiku prompt template for AI-powered session summaries
 *
 * Produces a prompt that instructs Haiku to generate a structured session note
 * from extracted user messages and git commits. The output format matches
 * PAI's existing session note structure (Reconstruct skill format).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummaryPromptParams {
  /** Extracted user messages from the JSONL transcript. */
  userMessages: string[];
  /** Git log output (--oneline --stat) for the session period. */
  gitLog: string;
  /** Working directory of the session. */
  cwd: string;
  /** ISO date string for the session. */
  date: string;
  /** Files modified during the session (from tool_use blocks). */
  filesModified?: string[];
  /** Existing session note content (if updating). */
  existingNote?: string;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the prompt string to send to Haiku for session summarization.
 *
 * Returns a single string suitable for piping to `claude --model haiku --print`.
 */
export function buildSessionSummaryPrompt(params: SummaryPromptParams): string {
  const {
    userMessages,
    gitLog,
    cwd,
    date,
    filesModified,
    existingNote,
  } = params;

  const userSection = userMessages.length > 0
    ? userMessages.map((m, i) => `[${i + 1}] ${m}`).join("\n\n")
    : "(No user messages extracted)";

  const gitSection = gitLog.trim() || "(No git commits during this session)";

  const filesSection = filesModified && filesModified.length > 0
    ? filesModified.map(f => `- ${f}`).join("\n")
    : "";

  const updateInstruction = existingNote
    ? `\nAn existing session note is provided below. Merge the new information into it,
preserving what was already written. Add new work items and update the summary.
Do NOT duplicate existing content.

EXISTING NOTE:
${existingNote}
`
    : "";

  return `You are summarizing a coding session. Given the user messages and git commits below, write a session note.

Project directory: ${cwd}
Date: ${date}

Focus on:
- What problems were encountered and how they were solved
- Key architectural decisions and their rationale
- What was built (reference actual files and code patterns)
- What was left unfinished or needs follow-up

Do NOT include:
- Mechanical metadata (token counts, checkpoint timestamps)
- System messages or tool results verbatim
- Generic descriptions — be specific about what happened
- Markdown frontmatter or YAML headers
${updateInstruction}
Format your response EXACTLY as follows (no extra text before or after):

# Session: [Descriptive Title - 5-8 words summarizing the main accomplishment]

**Date:** ${date}
**Status:** In Progress

---

## Work Done

[Organize by theme, not chronologically. Group related work under descriptive bullet points.
Use checkbox format: - [x] for completed items, - [ ] for incomplete items.
Include specific file names, function names, and technical details.]

## Key Decisions

[List important choices made during the session with brief rationale.
Skip this section entirely if no significant decisions were made.]

## Known Issues

[What was left unfinished, bugs discovered, or follow-up items needed.
Skip this section entirely if nothing is pending.]

---

USER MESSAGES:
${userSection}

GIT COMMITS:
${gitSection}
${filesSection ? `\nFILES MODIFIED:\n${filesSection}` : ""}`;
}
