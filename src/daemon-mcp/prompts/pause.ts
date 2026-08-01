export const pause = {
  description:
    "Save a checkpoint and prepare to exit safely, knowing you will come back to the same conversation",
  content: `## Pause Skill

USE WHEN user says /pause, pause session, pause this, OR wants to step away knowing they will come back to the same conversation.

### The rule that matters

**The checkpoint must be written to a FILE before it is printed.** Printing it to the
terminal does not persist it. If you print first and the session ends, the checkpoint is
gone and the user has to copy it off the screen by hand — which is the exact failure this
procedure exists to prevent.

Order is: **compose → write file → persist via CLI → print**. Never reorder.

### Procedure

1. **Compose the checkpoint.** It must be genuinely useful to a session that has none of
   your context. Include:

   - **Shipped/completed** — what actually landed, with versions or commit refs
   - **Open decisions** — anything blocked on a judgement call, stated as the question
   - **In flight** — built but not installed, written but not tested, etc.
   - **Watch items** — changes whose effects need observing, and why
   - **Cross-session work** — what other sessions are owed, or owe you

   Be specific. "Continue the refactor" is worthless; "the poller is built and tested but
   \`pai task schedule install\` has not been run" is a checkpoint.

2. **Write it to a file** with the Write tool:

   \`\`\`
   /tmp/pai-checkpoint-<session-id>.md
   \`\`\`

   Use the \`sessionId\` from the startup system reminders for \`<session-id>\`. Write the
   markdown body only — no \`## Continue\` heading and no \`## Pause Checkpoint\` heading.
   PAI adds those.

3. **Persist it** via Bash:

   \`\`\`bash
   pai pause --body-file /tmp/pai-checkpoint-<session-id>.md --session-id <session-id>
   \`\`\`

   This writes the body into \`## Continue\` in the project TODO.md **and** appends it to
   the current session note, then prints the safe-exit reminder.

   **If this command errors, do not proceed to step 4.** It refuses to write a
   metadata-only checkpoint, so an error here is the difference between a real checkpoint
   and a lost one. Fix the cause and re-run.

4. **Print the checkpoint to the user** — the same content you wrote in step 2, plus:

   \`\`\`
   To resume: claude --resume <session-id>
   \`\`\`

5. **Tell the user:**
   "Now type \`/exit\` to safely close the session. DO NOT press Ctrl+C — that bypasses PAI
   stop-hook and orphans the session so it cannot be resumed."

### Notes

- \`--session-id\` is what makes \`claude --resume\` recoverable from TODO.md alone, and it is
  also the key that protects your checkpoint from being overwritten. Always pass it.
- The next session receives this checkpoint automatically: the SessionStart hook reads
  \`## Continue\` and injects it. The user does not have to say "go" for it to arrive.
- The session-stop hook runs \`pai session handover\` on exit. It will **not** overwrite the
  checkpoint you just wrote — preservation is keyed on the session UUID, which survives the
  note rename and renumber that the same hook performs a few steps earlier. Unattributed
  content in older blocks is carried forward rather than dropped.
- A rolling autosave (\`pai session autosave\`, wired to UserPromptSubmit and PostToolUse)
  keeps a mechanical checkpoint fresh throughout the session, so an interrupted session
  still leaves something behind. It never replaces an authored checkpoint for the same
  session — yours always wins.
- \`--no-body\` exists for deliberate metadata-only checkpoints. Do not reach for it to work
  around a failure in step 2 or 3.
- Do **not** hand-place state below the generated header lines as a workaround. That was
  necessary when the block got clobbered; it no longer is, and \`--body-file\` puts the
  content somewhere that survives.`,
};
