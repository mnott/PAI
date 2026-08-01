export const end = {
  description:
    "Finalize a session: checkpoint, mark note completed, commit pending work if asked, then exit safely",
  content: `## End Skill

USE WHEN user says /end, end session, finish session, OR is done with this conversation entirely.

### The rule that matters

**The checkpoint must be written to a FILE before it is printed.** Printing it to the
terminal does not persist it — if the session ends, it is gone and the user has to copy it
off the screen by hand. Order is **compose → write file → persist via CLI → print**, and it
never varies.

### Procedure (extends Pause)

1. **Compose the checkpoint** — what was accomplished, what was left incomplete, open
   decisions, anything built but not installed, and any follow-up actions. Write it for a
   session that has none of your context.

1b. **Write it to a file** with the Write tool:

   \`\`\`
   /tmp/pai-checkpoint-<session-id>.md
   \`\`\`

   Use the \`sessionId\` from the startup system reminders. Body markdown only — no
   \`## Continue\` or \`## Session Complete\` heading; PAI adds those.

2. **Run \`pai end\`** via Bash:

   \`\`\`bash
   pai end --body-file /tmp/pai-checkpoint-<session-id>.md --session-id <session-id>
   \`\`\`

   This does everything \`pai pause\` does (writes the checkpoint into \`## Continue\` in
   TODO.md and appends it to the session note) PLUS marks the current session note
   **Status: Completed** with a timestamp.

   **If this errors, stop and fix it.** It refuses to write a metadata-only checkpoint, so
   an error here is the difference between a real checkpoint and a lost one.

2b. **File open items onto the task bus.**

   \`pai end\` writes the session note and TODO.md. It does **not** touch Todoist — it is a
   mechanical command, and deciding what counts as an open item needs judgement. So do it
   here, explicitly:

   \`\`\`bash
   pai task add "<open item>" --into <ProjectName> --owner <project> --body "<reasoning>"
   \`\`\`

   **Always use \`--into <ProjectName>\`** — one sub-project per PAI project, created
   automatically if missing. Doing so is *following the convention, not inventing
   structure*: filing flat into the root out of caution buries findings across projects,
   which is the mess the convention prevents. Omit \`--into\` only for something genuinely
   cross-cutting.

   Skip this only if nothing is actually open — say so rather than filing filler. Otherwise
   the open items exist solely in a session note nobody re-reads, which is exactly the loss
   the bus was built to stop.

3. **Check for uncommitted changes** with \`git status\`. If there are any, ask whether to
   commit them. If yes, use clean conventional-commit format — no AI signatures, no
   \`--no-verify\`.

4. **Print the handoff block** — the same content you wrote in step 1b, plus the session ID
   from the \`sessionId\` field in startup system reminders, and:

   \`\`\`
   To resume (if needed): claude --resume <uuid>
   \`\`\`

5. **Tell the user:**
   "Now type \`/exit\` to safely close the session. DO NOT press Ctrl+C — that bypasses PAI
   stop-hook and means the stop-hook finalization never runs."`,
};
