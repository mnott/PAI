/**
 * tool-wait.ts — a local worker that only waits on a long tool command does not hold a slot.
 *
 * The PreToolUse hook stamps `toolWaitSince` on a Bash call; once the command has run 20 s
 * (slotLent, status.ts) the worker no longer counts as a holder (capacity.ts check, preempt.ts
 * roomOn), so the next queued worker is admitted. The PostToolUse hook clears the stamp and, when the
 * slot was lent, takes a slot back through the same capacityGate at "high" tier: ahead of
 * normal-priority waiters. Fail-open: any error leaves the worker running.
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
  delete s.toolWaitSince;
  saveStatus(logDir, s, new Date(now), true);
  if (!lent) return null;
  const { workers } = readWorkersSection();
  const p = getProviderOrNative(workers, s.provider);
  if (!p) return null;
  const r = await gate({
    logDir,
    self: { id, provider: s.provider },
    cap: admitCap(p.maxConcurrent, p.conversationSlots, isLocalProvider(p.baseUrl), capacityOf(workers.capacity)),
    config: workers.capacity ?? {},
    tier: "high",
    log: () => {},
  });
  return r?.waitedSec ?? null;
}
