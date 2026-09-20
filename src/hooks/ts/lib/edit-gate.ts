/**
 * edit-gate.ts — the decision behind the PreToolUse edit-routing gate.
 *
 * Pure: no stdin, no filesystem, no process.env read of its own. The hook
 * entry (pre-tool-use/route-edits-to-worker.ts) resolves paths and checks the
 * filesystem/env, then hands this module the already-computed facts to
 * decide on — same split as lib/agent-gate.ts.
 */

import { basename, extname } from "node:path";

export interface EditGateContext {
  /** Absolute, already-resolved target path. */
  filePath: string;
  isPaiWorker: boolean;
  isExemptPrefix: boolean;
  isGitWorkTree: boolean;
}

export type EditGateDecision = { decision: "allow" } | { decision: "block"; reason: string };

/** Extensions that are prose regardless of which directory they live in. */
const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/**
 * True for notes, session logs, handovers and other prose the outer session
 * writes directly instead of routing through a worker — a `Notes`/`notes`
 * directory segment anywhere in the path, or a prose file extension.
 * Extension check runs first: a source file that happens to live under a
 * `notes/` directory is still code, but `src/foo.md` is still prose.
 */
export function isProseEdit(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (PROSE_EXTENSIONS.has(ext)) return true;
  return filePath.split(/[\\/]/).some((segment) => segment === "Notes" || segment === "notes");
}

export function decideEditGate(ctx: EditGateContext): EditGateDecision {
  if (ctx.isPaiWorker) return { decision: "allow" };
  if (ctx.isExemptPrefix) return { decision: "allow" };
  if (isProseEdit(ctx.filePath)) return { decision: "allow" };
  if (!ctx.isGitWorkTree) return { decision: "allow" };

  const label = basename(ctx.filePath).slice(0, 60) || "edit";
  return {
    decision: "block",
    reason:
      `main session does not edit code: run a worker instead — ` +
      `pai worker run --label "${label}" --class implement --output-format json -p <spec> (target: ${ctx.filePath})`,
  };
}
