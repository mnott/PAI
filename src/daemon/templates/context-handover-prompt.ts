/**
 * context-handover-prompt.ts — prompt template for the threshold-triggered
 * pre-compaction handover.
 *
 * This is NOT the session-note summary (session-summary-prompt.ts already
 * does that well, and Claude Code's own native compaction summary is also
 * genuinely detailed on file paths and issue numbers). This exists for the
 * one thing neither of those reliably carries: the reasoning behind what
 * happened, which compresses to bullets or vanishes outright once a native
 * compaction fires.
 *
 * FRAMING (lifted from a working example of this exact mechanism, read
 * before writing this prompt): the handover is a DIFF against everything
 * already durable, not a summary of the session. The successor can read
 * git, the tracker, and the notes — so this must not repeat what is
 * recoverable there. What cannot be recovered is what only ever existed in
 * the conversation: reasoning, rejected alternatives, negative results and
 * what they cost, traps discovered but invisible in the repo, and specific
 * values/ids/paths that would otherwise have to be dug up again.
 *
 * Length is not a target. A short session earns a short handover; every
 * line in a long one must be something the successor could not have
 * obtained anywhere else.
 */

export interface HandoverPromptParams {
  /** Interleaved user + assistant turns, oldest first, each prefixed with
   *  who said it — this prompt needs the assistant's reasoning, not just
   *  what the user asked for. */
  turns: string[];
  /** Git log output for the session period, if any. */
  gitLog: string;
  cwd: string;
  /** The previous cached handover's summary text, if this session already
   *  produced one (the warmup handover, when this call is the refresh).
   *  Passed through so the new handover can carry it forward rather than
   *  silently dropping everything it already captured — see the "pointer
   *  to the previous handover, kept rather than superseded" structure. */
  previousHandover?: string;
}

export function buildContextHandoverPrompt(params: HandoverPromptParams): string {
  const { turns, gitLog, cwd, previousHandover } = params;

  const turnsSection = turns.length > 0
    ? turns.join("\n\n")
    : "(No turns extracted)";

  const gitSection = gitLog.trim() || "(No git commits during this session)";

  const previousSection = previousHandover
    ? `\nA PREVIOUS HANDOVER already exists for this session (from an earlier, \
lower threshold). Carry it forward — start your response with a one-line \
pointer to it ("Carries forward from the previous handover, which stays for \
its detail.") and then write only what has happened SINCE it that a compact \
would also lose. Do not re-derive or repeat what it already covered.\n\n\
PREVIOUS HANDOVER:\n${previousHandover}\n`
    : "";

  return `This session is approaching a context-window compaction. Write the \
handover that would let a successor continue WITHOUT re-reading this \
conversation and WITHOUT asking the user to repeat themselves.

Project directory: ${cwd}
${previousSection}
SCOPING RULE — the single most important instruction here: this is a DIFF \
against everything already durable, not a summary of the session. Assume \
the successor can and will read git history, the issue tracker, and any \
notes files themselves. Do NOT restate anything recoverable there — no file \
inventories, no "implemented X" restatements, no chronology of commands run. \
Write down ONLY what existed exclusively in this conversation and would \
otherwise be gone: the reasoning, not the result.

Write ONLY the sections below that this session actually has content for — \
omit a section entirely rather than writing "none" or padding it:

WHERE THIS SESSION ENDED — the concrete state right now: what is verified \
working (tests green, tree clean, etc.) versus merely attempted, any branch \
or working-tree state that isn't obvious from git status alone (e.g. a \
detached HEAD, an intentionally uncommitted change, a stash).

WHAT CLOSED — each item paired with the evidence that closed it, not just \
the claim that it did.

WHAT IS FILED AND STILL OPEN — each with its next concrete step or who/what \
it is waiting on.

DECISIONS & REASONING — choices actually made, each with why this way and \
not another way.

REJECTED ALTERNATIVES — approaches considered and set aside, and why. An \
alternative without a reason is not worth recording.

NEGATIVE RESULTS — something investigated that turned out NOT to be the \
answer, kept WITH the reasoning that ruled it out (e.g. "X looked like the \
cause — it wasn't; the actual mechanism was Y"). Without the reasoning \
attached, a successor re-investigates the same dead end.

TRAPS — anything discovered that is invisible from the repo alone and would \
otherwise bite a successor immediately (a required manual step, an ordering \
constraint, a state that looks fine but isn't).

CRITICAL VALUES — any specific id, path, URL, credential name, version \
number, or configuration value that appeared in conversation and whose loss \
would force someone to go find it again.

THE FEW THINGS THAT MATTER MOST, IF NOTHING ELSE IS READ — at most 3 bullets. \
Forces a priority judgement; do not pad this to fill space.

Format your response as markdown with those section headers (only the ones \
you have content for), no other structure.

---

CONVERSATION:
${turnsSection}

GIT COMMITS:
${gitSection}`;
}
