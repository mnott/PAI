/**
 * tool-wait.ts — a local worker that only waits on a long tool command does not hold a slot.
 *
 * The PreToolUse hook stamps `toolWaitSince` on a Bash call; once the command has run 20 s
 * (slotLent, status.ts) the worker no longer counts as a holder (capacity.ts check, preempt.ts
 * roomOn), so the next queued worker is admitted. The PostToolUse hook clears the stamp and, when the
 * slot was lent, takes a slot back through the same capacityGate at "high" tier: ahead of
 * normal-priority waiters and ahead of every not-yet-started job (returning ticket). Fail-open: any error leaves the worker running.
 */

import { getProviderOrNative, isLocalProvider, readWorkersSection } from "./config.js";
import { capacityGate, capacityOf, admitCap } from "./capacity.js";
import { loadStatus, saveStatus, slotLent } from "./status.js";

/** The worker starts a Bash command: stamp it. Only a local provider's workers hold slots worth lending. */
export function markToolWait(logDir: string, id: string, now = Date.now()): void {
  const s = loadStatus(logDir, id);
  if (!s || s.state !== "running") return;
  const p = getProviderOrNative(readWorkersSection().workers, s.provider);
  if (!p || !isLocalProvider(p.baseUrl)) return;
  s.toolWaitSince = now;
  saveStatus(logDir, s, new Date(now), true);
}

/** The command returned: clear the stamp; when the slot was lent, wait for a free one ahead of normal waiters. */
export async function returnFromToolWait(logDir: string, id: string, now = Date.now(), gate: typeof capacityGate = capacityGate): Promise<number | null> {
  const s = loadStatus(logDir, id);
  if (!s || s.toolWaitSince === undefined) return null;
  const lent = slotLent(s, now);
  const clear = (): void => {
    const cur = loadStatus(logDir, id);
    if (!cur || cur.toolWaitSince === undefined) return;
    delete cur.toolWaitSince;
    saveStatus(logDir, cur, new Date(), true);
  };
  const { workers } = readWorkersSection();
  const p = lent ? getProviderOrNative(workers, s.provider) : undefined;
  if (!lent || !p) {
    clear();
    return null;
  }
  // The stamp stays while the job waits for a slot: a started job without a slot is "lent" for every counter
  // (slot line, queue table, ps), never a holder above the cap. It is cleared once the slot is granted.
  let r;
  try {
    r = await gate({
      logDir,
      self: { id, provider: s.provider },
      cap: admitCap(p.maxConcurrent, p.conversationSlots, isLocalProvider(p.baseUrl), capacityOf(workers.capacity)),
      config: workers.capacity ?? {},
      tier: "high",
      // it already holds context and a worktree: ahead of every job that has not started
      returning: true,
      log: () => {},
    });
  } finally {
    clear();
  }
  return r?.waitedSec ?? null;
}
