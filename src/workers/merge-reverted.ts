/**
 * A gate step that reverted the merge (a failed verify, a stub/test/duplicate
 * scan, failed related tests, a failed smoke start, or a restart-health
 * rollback): main runs the old code again and the command must say so LAST.
 * The CLI prints this message, then `MERGE REVERTED: <reason>` as the last
 * line of its output and exits 4 — never ok-looking lines after a revert
 * (merge 2026-11-19 14:31: a smoke revert printed "build: ok … restart
 * health: ok" after the failure line and exited 0).
 */
export class MergeRevertedError extends Error {
  /** The output of `pai worker merge` on a reverted gate: the revert line is always last. */
  static readonly EXIT_CODE = 4;
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** One line for the message: the first, trimmed, with no trailing newline. */
function oneLine(s: string): string {
  return s.split("\n")[0]!.trim();
}

/** The last output line of a reverted merge: `MERGE REVERTED: <reason>` (never doubled, never nested). A reason
 * carrying multiple lines (verify's detail block) names the gate's own head line, not its captured output. */
export function mergeRevertedLine(reason: string): string {
  return `MERGE REVERTED: ${oneLine(reason.replace(/^MERGE REVERTED: /, "").split("\n").find((l) => l.trim() && !/^\s/.test(l)) ?? "merge reverted")}`;
}

/**
 * Wrap a thrown gate failure whose text shows the merge was reverted (a revert
 * already landed on main). A message that merely mentions a revert it could not
 * perform, or names a pre-existing revert commit, is not a reverted merge.
 */
export function asMergeReverted(e: unknown): MergeRevertedError | null {
  if (e instanceof MergeRevertedError) {
    // already classified: never re-wrapped, but a message whose last line is not yet the revert line gains it —
    // gate steps build their own text and only guarantee MERGE REVERTED last on their happy-classification paths
    const own = e.message;
    if ((own.split("\n").at(-1) ?? "").startsWith("MERGE REVERTED: ")) return e;
    return new MergeRevertedError(`${own}\n${mergeRevertedLine(own)}`);
  }
  const msg = e instanceof Error ? e.message : String(e);
  // a message already ending with the revert line was built by a gate step that reverted: pass it through untouched,
  // never re-wrapped (a second MERGE REVERTED naming the whole text would follow the real one)
  if ((msg.split("\n").filter((l) => l.trim()).at(-1) ?? "").startsWith("MERGE REVERTED: ")) return new MergeRevertedError(msg);
  // the revert shapes of the merge gate's failures ("…: reverted <sha>; the worker branch is kept",
  // "…: reverted <sha>; branch kept: …"); a message that only mentions a revert it could not perform
  // ("the rollback's git revert failed", "could not re-apply the reverted merge") is not a reverted merge
  // the gate's revert shapes: "…: reverted <sha>; … branch is kept/kept: …", the rollback line's own wording, and
  // the smoke failure line whose rebuild tail reports the revert (both land on main; a failed revert never matches).
  // the message gains the revert line here too: mergeWorker's catch passes such an error through untouched
  if (/reverted \S+; (?:the worker )?branch(?: is)? kept/.test(msg)) return new MergeRevertedError(`${msg}\n${mergeRevertedLine(msg)}`);
  if (/rolled back to/.test(msg) && !/git revert failed/.test(msg)) return new MergeRevertedError(`${msg}\n${mergeRevertedLine(msg)}`);
  if (/smoke start failed:/.test(msg) && /merge reverted, dist rebuilt from the old tree/.test(msg)) return new MergeRevertedError(`${msg}\n${mergeRevertedLine(msg)}`);
  return null;
}

/** The exit code of `pai worker merge`: 4 for a reverted gate, else RelatedTestsFailedError's 3, else 1. */
export function mergeExitCode(e: unknown): number {
  if (e instanceof MergeRevertedError) return MergeRevertedError.EXIT_CODE;
  // the class lives in worktree.ts; matched by name so this module stays import-light for the CLI
  // (name, not constructor: a test can stand in for it with Object.assign(new Error(…), {name}))
  if (e instanceof Error && e.name === "RelatedTestsFailedError") return 3;
  return 1;
}
