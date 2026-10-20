/**
 * pane-launch.ts — the one launcher: open the pane FIRST, then run the command as the child of
 * `pai pane exec` inside it (see pane-exec.ts). Used by `pai worker run`, `pai pane run` (and with
 * it `pai build run` and the plan runner).
 *
 * No terminal at all (no iTerm2 session, no tmux): `launchPane` resolves to null and the caller runs
 * the command directly; the ledger records it as "no terminal" (PANE-NOTERMINAL), not a violation.
 * Any other failure to open the pane rejects: the pane rule wins, the command does not run unseen.
 */

import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import type { WorkersConfig } from "./config.js";
import { NoTerminalError, closePaneForWorker, headlessAllowed, openVerifiedPane, realPaneOps, type PaneOps, type PaneSeam } from "./pane.js";
import { openOwnedPane, type OpenOwnedOptions, type OwnedPane } from "./pane-exec.js";

export interface LaunchOptions {
  logDir: string;
  config: WorkersConfig;
  /** Run id: the worker id, plan id or pane-run id; names the pane, the socket and the exit file. */
  id: string;
  kind: "worker" | "plan" | "pane";
  /** The session's iTerm id (resolveHostSession().term). */
  term: string;
  env?: NodeJS.ProcessEnv;
  ops?: PaneOps;
  seam?: PaneSeam;
  /** Test seam: replaces the whole pane opener (receives the wrapper command). */
  open?: OpenOwnedOptions["open"];
  helloMs?: number;
  command?: string;
}

/** Why a launch ran without a pane, per run id (status.pane records it). */
export const noTerminalReasons = new Map<string, string>();

/**
 * Open the pane that will own the run `id`. Resolves to the owned pane, or to null when the command
 * is to run directly: no terminal at all, or the operator's explicit hidden-run override.
 */
export async function launchPane(o: LaunchOptions): Promise<OwnedPane | null> {
  const env = o.env ?? process.env;
  const allow = headlessAllowed(env);
  if (allow) {
    noTerminalReasons.set(o.id, `hidden run allowed: ${allow}`);
    return null;
  }
  const ops = o.ops ?? realPaneOps;
  try {
    return await openOwnedPane({
      id: o.id,
      kind: o.kind,
      open: o.open ?? ((command) => openVerifiedPane(o.logDir, o.config, o.id, o.term, env, ops, { ...o.seam, command })),
      closeFailed: () => closePaneForWorker(o.logDir, o.id, ops),
      helloMs: o.helloMs,
      command: o.command,
    });
  } catch (e) {
    if (e instanceof NoTerminalError) {
      noTerminalReasons.set(o.id, "no terminal");
      appendLedger(ledgerPath(o.logDir), "PANE-NOTERMINAL", { id: o.id, kind: o.kind, reason: e.message.slice(0, 200) });
      return null;
    }
    throw e;
  }
}
