/**
 * note-delivery.ts — hand `pai worker goal` notes to the running worker.
 *
 * `goal` only stores the note in the status file; nothing reads it back into
 * the worker's conversation. The PostToolUse hook (hooks/ts/post-tool-use/
 * worker-note.ts) calls takePendingNotes after every tool call: each note is
 * returned exactly once and the delivery time is recorded for `pai worker ps`.
 */

import { randomBytes } from "node:crypto";
import { parseRunnerArgs } from "./args.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { loadStatus, nowStamp, saveStatus } from "./status.js";

/** The pending notes of a worker, cleared and stamped as delivered; null when there are none. */
export function takePendingNotes(logDir: string, id: string, d: Date = new Date()): string[] | null {
  const status = loadStatus(logDir, id);
  if (!status?.notePending?.length) return null;
  const notes = status.notePending;
  status.notePending = [];
  status.noteDeliveredAt = nowStamp(d);
  saveStatus(logDir, status, d, true);
  appendLedger(ledgerPath(logDir), "WORKER-NOTE-DELIVERED", { id, count: notes.length }, d);
  return notes;
}

/** Env var carrying the per-run note token from the runner to the worker's hooks. */
export const NOTE_TOKEN_ENV = "PAI_WORKER_NOTE_TOKEN";

/** A fresh random per-run token (8 hex chars). */
export function newNoteToken(): string {
  return randomBytes(4).toString("hex");
}

/** The additionalContext text for the delivered notes, each authenticated with the run's token. */
export function noteContext(notes: string[], token: string): string {
  return notes.map((n) => `PAI note [${token}] from your orchestrator: ${n}`).join("\n");
}

/** Header of the goals section a continuation's prompt ends with. */
export const GOALS_HEADER = "Operator goals given to the previous run (apply them, in order):";

type Goal = { text: string; at: string };

/**
 * Every goal given to the runs `priorIds` name, oldest first: the runs' own `goals` history (a run whose status
 * predates it falls back to `note`), pending ones included, plus — through `fallThroughOf` — the runs those continued,
 * so a chain A -> B -> C hands A's and B's goals to C. Goals already given to an earlier run of the chain count once.
 */
export function collectGoals(logDir: string, priorIds: string[]): Goal[] {
  const seen = new Set<string>();
  const out: Goal[] = [];
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const st = loadStatus(logDir, id);
    if (!st) return;
    if (st.fallThroughOf) walk(st.fallThroughOf);
    const own = st.goals ?? [...(st.notePending ?? []), ...(st.note ? [st.note] : [])].filter((t, i, a) => a.indexOf(t) === i).slice(-1).map((text) => ({ text, at: "" }));
    out.push(...own);
  };
  for (const id of priorIds) walk(id);
  return out;
}

/** The prompt without a goals section from an earlier continuation, then the current section appended; unchanged without goals. */
export function withGoals(prompt: string, goals: Goal[]): string {
  const at = prompt.indexOf(`\n\n${GOALS_HEADER}`);
  const base = at >= 0 ? prompt.slice(0, at) : prompt;
  if (!goals.length) return base;
  const lines = goals.map((g, i) => `${i + 1}. ${g.at ? `[${g.at}] ` : ""}${g.text}`);
  return `${base}\n\n${GOALS_HEADER}\n${lines.join("\n")}`;
}

/**
 * The one place every continuation (escalation, fall-through/hand-off, reroute, empty retry) gets the goals of the
 * runs it continues: the prompt in `claudeArgs` is swapped for one ending with the goals section. The origins' pending,
 * undelivered notes are taken over here (cleared on them), so the dead origin's hook never delivers them again.
 */
export function carryGoals(logDir: string, claudeArgs: string[], priorIds: string[] | undefined): string[] {
  if (!priorIds?.length) return claudeArgs;
  const p0 = parseRunnerArgs(claudeArgs).prompt;
  if (!p0) return claudeArgs;
  const goals = collectGoals(logDir, priorIds);
  if (!goals.length) return claudeArgs;
  for (const id of priorIds) {
    const st = loadStatus(logDir, id);
    if (st?.notePending?.length) {
      st.notePending = [];
      saveStatus(logDir, st, new Date(), true);
    }
  }
  const next = withGoals(p0, goals);
  let swapped = false;
  return claudeArgs.map((x) => (!swapped && x === p0 ? ((swapped = true), next) : x));
}
