/**
 * fail-ledger.ts — per-run FAIL ledger (experiment, workers.failLedger; off by default).
 *
 * After DeLM's FAIL entries: a short list of approaches this run already found dead (the same command failing the
 * same way, a path that does not exist, a file version a test run failed with). The loop guard records entries into
 * its state; the PostToolUse hook appends the last few to the tool result when a new one arrived in this turn.
 */

import { redactSecrets as maskSecrets } from "../../../utils/redact.js";
import type { LoopState } from "./loop-guard.js";

export type FailKind = "repeat-failure" | "missing-path" | "restored-failing-version";

export interface FailEntry {
  kind: FailKind;
  /** The command or file the entry is about. */
  scope: string;
  /** First error line, secrets masked, at most EVIDENCE_CHARS. */
  evidence: string;
  turn: number;
}

export interface FailLedgerState {
  entries: FailEntry[];
  /** Guard steps taken so far (one per tool call). */
  turn: number;
  /** Turn whose entries were already handed to the model. */
  shown?: number;
  /** Command -> "exit|first error line" of its last failure; a second identical one is a repeat. */
  sigs?: Record<string, string>;
  /** File -> write keys that were on disk when a run failed. */
  bad?: Record<string, string[]>;
}

export interface FailLedgerConfig {
  enabled: boolean;
  maxEntries: number;
}

export const EVIDENCE_CHARS = 160;
const STORE_CAP = 50;
const SIG_CAP = 40;

/** PAI_FAIL_LEDGER=1 / 0 overrides the configured switch for one run (bench A/B). */
export function failLedgerOn(env: NodeJS.ProcessEnv, cfg?: Partial<FailLedgerConfig>): FailLedgerConfig | undefined {
  const flag = env.PAI_FAIL_LEDGER;
  const on = flag === "1" || flag === "true" ? true : flag === "0" || flag === "false" ? false : !!cfg?.enabled;
  return on ? { enabled: true, maxEntries: cfg?.maxEntries && cfg.maxEntries > 0 ? cfg.maxEntries : 5 } : undefined;
}

/** First line of an output that names the error, else its first non-empty line. */
export function firstErrorLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /error|fail|not found|cannot|can't|no such|denied|✗|✘/i.test(l)) ?? lines[0] ?? "";
  return maskSecrets(hit).slice(0, EVIDENCE_CHARS);
}

function ledgerOf(state: LoopState): FailLedgerState {
  return state.fail ?? { entries: [], turn: 0 };
}

function add(f: FailLedgerState, e: Omit<FailEntry, "turn">): FailLedgerState {
  const dup = f.entries.some((x) => x.turn === f.turn && x.kind === e.kind && x.scope === e.scope);
  return dup ? f : { ...f, entries: [...f.entries, { ...e, turn: f.turn }].slice(-STORE_CAP) };
}

/** PreToolUse side: starts a turn and records a missing path or the restore of a version a run failed with. */
export function ledgerStep(state: LoopState, tool: string, writeKey: string | null, file: string | null, missing: string | null): LoopState {
  let f: FailLedgerState = { ...ledgerOf(state), turn: ledgerOf(state).turn + 1 };
  if ((tool === "Read" || tool === "Glob") && missing) f = add(f, { kind: "missing-path", scope: missing, evidence: `${tool}: path does not exist` });
  if (tool === "Write" && writeKey && file && f.bad?.[file]?.includes(writeKey)) {
    f = add(f, { kind: "restored-failing-version", scope: file, evidence: "this content was on disk when a run failed" });
  }
  return { ...state, fail: f };
}

/** PostToolUse side: a failing Bash command repeating its earlier failure; a failure remembers the written file versions. */
export function ledgerResult(state: LoopState, tool: string, command: string | undefined, text: string, code: number | null, failed: boolean): LoopState {
  if (tool !== "Bash" || !command) return state;
  let f = ledgerOf(state);
  const sigs = { ...(f.sigs ?? {}) };
  if (code === 0 || (code === null && !failed)) {
    delete sigs[command];
    const { bad: _bad, ...rest } = f;
    return { ...state, fail: { ...rest, sigs } };
  }
  const sig = `${code ?? 1}|${firstErrorLine(text)}`;
  const repeat = sigs[command] === sig;
  sigs[command] = sig;
  for (const k of Object.keys(sigs).slice(0, -SIG_CAP)) delete sigs[k];
  const bad: Record<string, string[]> = {};
  for (const [file, w] of Object.entries(state.writes ?? {})) bad[file] = [...new Set([...(f.bad?.[file] ?? []), w.key])].slice(-10);
  f = { ...f, sigs, bad };
  if (repeat) f = add(f, { kind: "repeat-failure", scope: command.slice(0, 120), evidence: `exit ${code ?? 1}: ${firstErrorLine(text)}`.slice(0, EVIDENCE_CHARS) });
  return { ...state, fail: f };
}

/** The block for the model when this turn added an entry (once per turn), and the state that remembers it was shown. */
export function ledgerNote(state: LoopState, maxEntries: number): { note: string; state: LoopState; entry: FailEntry } | undefined {
  const f = state.fail;
  const last = f?.entries.at(-1);
  if (!f || !last || last.turn !== f.turn || f.shown === f.turn) return undefined;
  const lines = f.entries.slice(-maxEntries).map((e) => `- ${e.kind}: ${maskSecrets(e.scope)} -- ${maskSecrets(e.evidence)} (turn ${e.turn})`);
  return { note: `Already failed in this run (do not repeat):\n${lines.join("\n")}`, state: { ...state, fail: { ...f, shown: f.turn } }, entry: last };
}
