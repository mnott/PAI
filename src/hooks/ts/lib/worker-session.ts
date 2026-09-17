/**
 * Worker-session detection.
 *
 * A disposable headless worker (a `claude -p` run started by an orchestrating
 * session, possibly against a different model provider with a different
 * context window) shares the project directory and the hook configuration
 * with the real session that spawned it. Left alone, the hooks treat it as a
 * session in its own right: they inject project context into it, create and
 * rename a numbered session note for it, autosave it, and enqueue a
 * model-written handover for it. Its compactions also land in the project's
 * transcript folder, where they are indistinguishable from a real session's
 * and drag the measured compaction trigger down (observed 2026-09-17: two
 * workers compacting at ~151k tokens pulled a project's trigger from ~784k
 * to ~151k, and the real session's handover fired at ~50k tokens).
 *
 * The launcher marks such sessions with `PAI_WORKER=1`. Every hook that does
 * per-session bookkeeping returns immediately when this predicate is true.
 * Deliberately NOT guarded: the security validator (a worker's shell
 * commands must still be checked) and observability capture.
 */
export function isWorkerSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAI_WORKER === "1";
}
