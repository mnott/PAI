/**
 * The part of a worker's stream fold that every run shares, fresh or pooled:
 * tool-error records, the Edit hint, the
 * Bash accounting the proof check reads, and the proof check itself. One copy.
 */
import { appendLedger } from "../ledger.js";
import { editHintFor } from "../edit-assist.js";
import { recordToolError } from "../tool-errors.js";
import { checkProof, newUntracked, parseWorkerReport, type BashRun, type WorkerReport } from "../report.js";
import { shortText } from "../args.js";
import { bashCommand, toolResultFailed, toolResultText } from "./stream.js";

export interface ToolFoldOpts {
  logDir: string;
  worker: string;
  provider: string;
  label: string;
  /** Working directory the Edit hint reads files under. */
  cwd: string;
  granted?: string[];
  /** Delivers a harness line to the worker as a user turn. */
  inject: (text: string) => void;
}

export interface ToolFold {
  uses: Map<string, { name: string; input: unknown }>;
  bashRuns: BashRun[];
  onToolUse(block: { id?: string; name?: string; input?: unknown }): void;
  onToolResult(block: { tool_use_id?: string; is_error?: boolean; content?: unknown }): void;
}

export function createToolFold(o: ToolFoldOpts): ToolFold {
  const uses = new Map<string, { name: string; input: unknown }>();
  const bashRuns: BashRun[] = [];
  return {
    uses,
    bashRuns,
    onToolUse(block) {
      if (block.id) uses.set(block.id, { name: block.name ?? "?", input: block.input });
    },
    onToolResult(block) {
      const use = block.tool_use_id ? uses.get(block.tool_use_id) : undefined;
      const text = toolResultText(block.content);
      if (block.is_error === true) {
        const tool = use?.name ?? "?";
        recordToolError(o.logDir, {
          worker: o.worker,
          provider: o.provider,
          label: o.label,
          tool,
          text,
          input: use?.input,
          granted: o.granted,
          cwd: o.cwd,
        });
        if (use?.name === "Edit") {
          const hint = editHintFor(use.input, text, o.cwd);
          if (hint) o.inject(`[harness] ${hint}`);
        }
      }
      if (use?.name === "Bash") bashRuns.push({ command: bashCommand(use.input), failed: toolResultFailed(block), output: text.slice(-400) });
    },
  };
}

export interface ProofOutcome {
  /** The (possibly rewritten) result text. */
  text: string;
  report: WorkerReport | null;
  stray: string[];
  rewritten: boolean;
  proof?: string;
}

/** Proof check against THIS run's Bash calls and the untracked files it added; ledgered once when the claim fails. */
export function runProofCheck(
  result: string,
  bashRuns: BashRun[],
  dir: string,
  untrackedAtStart: Set<string>,
  ledger: string,
  wid: string
): ProofOutcome {
  const stray = newUntracked(dir, untrackedAtStart);
  const chk = checkProof(result, bashRuns, stray);
  const changed = chk.rewritten || stray.length > 0;
  const report = changed ? parseWorkerReport(chk.text) : null;
  if (report && stray.length) report.untracked = stray;
  if (chk.rewritten) appendLedger(ledger, "REPORT-PROOF-UNVERIFIED", { id: wid, proof: chk.proof ?? "?" });
  return { text: changed ? chk.text : result, report, stray, rewritten: chk.rewritten, proof: chk.proof };
}

export function proofNote(proof: string | undefined): string {
  return shortText(`claimed proof not run or failed: ${proof}`, 90);
}
