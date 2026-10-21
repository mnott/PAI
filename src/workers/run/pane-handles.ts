/**
 * run/pane-handles.ts — owned pane handles (module state) and pane start helpers, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { spawn } from "node:child_process";
import { shortText } from "../args.js";
import { readWorkersSection } from "../config.js";
import { appendLedger } from "../ledger.js";
import { type WorkerStatus } from "../status.js";
import { headlessAllowed } from "../pane.js";
import { launchPane, noTerminalReasons } from "../pane-launch.js";
import { type OwnedPane } from "../pane-exec.js";
import { type StatusLineSpec } from "../pane-bar.js";

/** The panes opened FIRST for the runs of this process, per worker id, until the run's command starts in them. */
export const paneHandles = new Map<string, OwnedPane>();

/** The run will not start its command (it ended or fell through first): its pane closes. */
export function releasePane(wid: string | undefined): void {
  if (!wid) return;
  paneHandles.get(wid)?.cancel();
  paneHandles.delete(wid);
}

/**
 * Open the worker's pane FIRST: the pane's command is `pai pane exec <id>`, which will own the claude process
 * (see pane-exec.ts). Resolves true when the pane exists and waits for the command (spawnOwned starts it in
 * there). false, with no failure: no terminal at all (recorded "no terminal"), `dryRun` (--print-cmd), an
 * explicit noPane, the operator's override, or workers.pane.enabled false; the command then runs directly.
 * A pane that cannot be opened for any other reason rejects: the command does not run unseen.
 */
export async function requireVisiblePane(
  logDir: string,
  config: ReturnType<typeof readWorkersSection>["workers"],
  wid: string,
  term: string,
  noPane: boolean,
  dryRun: boolean,
  ledger: string
): Promise<boolean> {
  if (dryRun || noPane) return false; // config and PAI_WORKER_AUTOPANE no longer skip a pane: the pane rule has no switch
  const allow = headlessAllowed();
  if (allow) {
    process.stderr.write(`[pai worker] hidden run allowed for ${wid}: ${allow}\n`);
    return false;
  }
  if (paneHandles.has(wid)) return true;
  try {
    const pane = await launchPane({ logDir, config, id: wid, kind: "worker", term });
    if (!pane) return false;
    paneHandles.set(wid, pane);
    process.stderr.write(`[pai worker] pane opened for ${wid}: ${pane.where}\n`);
    return true;
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    appendLedger(ledger, "WORKER-NO-PANE", { id: wid, reason });
    process.stderr.write(`[pai worker] ${wid} not started: its pane could not be opened: ${reason}\n`);
    throw new Error(`pane could not be opened: ${reason}`);
  }
}

/**
 * Start a run's command: inside the pane opened for it (the wrapper's child, output rendered there), or
 * directly when no pane owns this run (no terminal, interactive, override).
 */
export async function spawnOwned(
  wid: string,
  cmd: string[],
  o: { env: NodeJS.ProcessEnv; cwd: string; stdio: ["pipe" | "ignore", "pipe", "pipe" | "inherit"] | "inherit"; render?: "plain" | "stream"; title: string; statusLine?: StatusLineSpec }
): Promise<ReturnType<typeof spawn>> {
  const pane = paneHandles.get(wid);
  if (!pane || o.stdio === "inherit") return spawn(cmd[0], cmd.slice(1), { env: o.env, cwd: o.cwd, stdio: o.stdio });
  paneHandles.delete(wid);
  const proc = (await pane.start({ argv: cmd, cwd: o.cwd, env: o.env as Record<string, string | undefined>, stdin: o.stdio[0] === "pipe" ? "pipe" : "ignore", render: o.render ?? "plain", title: o.title, ...(o.statusLine ? { statusLine: o.statusLine } : {}) })).asChild();
  if (o.stdio[2] === "inherit") proc.stderr?.pipe(process.stderr);
  return proc;
}

/** status.last for a claude start that died before any model event: its stderr, not a bare "starting". */
export function preEventFailure(rc: number, turns: number, stderrTail: string): string | null {
  if (rc === 0 || turns > 0 || !stderrTail.trim()) return null;
  return "failed before any model event: " + shortText(stderrTail, 150);
}

/**
 * Records, in the status, why a run has no pane of its own (stdout stays pure JSON for `--output-format
 * json`): no terminal, --no-pane, config, the operator's override. A run with a pane is marked exec. Never
 * opens a pane: panes are opened by requireVisiblePane, before the command starts.
 */
export async function announcePane(
  logDir: string,
  config: ReturnType<typeof readWorkersSection>["workers"],
  wid: string,
  term: string,
  noPane: boolean,
  ledger: string,
  status?: WorkerStatus
): Promise<void> {
  const setPane = (p: NonNullable<WorkerStatus["pane"]>): void => {
    if (status) status.pane = p;
  };
  void logDir;
  void term;
  if (paneHandles.has(wid)) {
    setPane({ opened: true, exec: true });
    return;
  }
  const why = noTerminalReasons.get(wid) ?? (noPane ? "--no-pane" : headlessAllowed() ?? "no pane owns this run");
  process.stderr.write(`[pai worker] no pane for ${wid}: ${why}\n`);
  setPane({ opened: false, reason: why });
  void ledger;
}
