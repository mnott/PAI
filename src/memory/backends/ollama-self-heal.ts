/**
 * Self-heal for a broken local Ollama runner. A long-lived `ollama serve` can end
 * up in a broken Metal state (after a machine crash, say): /api/embed then answers
 * HTTP 500 "llama-server process has terminated ... failed to initialize the Metal
 * library" until the runtime is restarted. The embed client restarts it once through
 * the same path as `pai models stop|start <runtime>` (models.runtimes.<runtime>),
 * at most once per EMBED_HEAL_MIN_GAP_MS; the stamp lives in a file because the
 * daemon's embed pass runs in a child process.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paiHomePath } from "../../config/pai-home.js";

export const EMBED_HEAL_MIN_GAP_MS = 10 * 60_000;
export const EMBED_HEAL_EVENT = "EMBED-SELF-HEAL";

const BROKEN_RUNNER = [
  "process has terminated",
  "failed to initialize the Metal library",
  "failed to initialize MTL",
  "failed to allocate context",
];

/** The matched phrase when an HTTP 500 body says the runner or its GPU backend is broken; else null. */
export function brokenRunnerReason(status: number, body: string): string | null {
  if (status !== 500) return null;
  return BROKEN_RUNNER.find((p) => body.includes(p)) ?? null;
}

export interface SelfHeal {
  /** Restart the runtime and wait until it is ready; false = it did not come back. */
  restart: (runtime: string, reason: string) => Promise<{ ok: boolean; message: string }>;
  /** Epoch ms of the last restart (0 = never). */
  lastRestart: () => number;
  stamp: (at: number) => void;
  now: () => number;
}

const stampFile = (): string => paiHomePath("state", "embed-self-heal.json");

/** The production seam: runtimeStartStop (stop, then start with its ready check) and a stamp file. */
export function liveSelfHeal(): SelfHeal {
  return {
    now: Date.now,
    lastRestart() {
      try {
        return Number((JSON.parse(readFileSync(stampFile(), "utf8")) as { at?: number }).at) || 0;
      } catch {
        return 0;
      }
    },
    stamp(at) {
      try {
        mkdirSync(dirname(stampFile()), { recursive: true });
        writeFileSync(stampFile(), JSON.stringify({ at }) + "\n", "utf8");
      } catch { /* a missing stamp only allows an earlier next restart */ }
    },
    async restart(runtime, reason) {
      const { defaultDeps, runtimeStartStop } = await import("../../router/cockpit-actions.js");
      const { appendLedger } = await import("../../workers/ledger.js");
      const deps = defaultDeps();
      appendLedger(deps.ledger, EMBED_HEAL_EVENT, { runtime, reason: reason.replace(/\s+/g, "_") });
      const stop = await runtimeStartStop(runtime, "stop", deps);
      if (!stop.ok) return stop;
      return await runtimeStartStop(runtime, "start", deps);
    },
  };
}
