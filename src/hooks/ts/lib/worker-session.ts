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

/**
 * A daemon-spawned background LLM run (`claude -p` from planLlmSpawn /
 * planSummarySpawn: session summarizer, topic probe, KG extraction).
 *
 * Such a run is text-in/text-out and must never be summarized itself: its
 * SessionEnd/Stop hooks used to enqueue a summary of the summarizer's own
 * transcript, which spawned another summarizer, which ended, and so on — an
 * unbounded feedback loop of 401 daemon LLM runs observed on 2026-11-24, each
 * occupying a local model slot until its 300 s timeout. The spawn sets
 * `PAI_DAEMON_LLM=1`; every hook that does per-session bookkeeping returns
 * immediately when this predicate is true.
 */
export function isDaemonLlmSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAI_DAEMON_LLM === "1";
}
