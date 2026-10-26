/**
 * run/pane-handles.ts — owned pane handles (module state) and pane start helpers, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { spawn } from "node:child_process";
import { shortText } from "../args.js";
import { readWorkersSection } from "../config.js";
import { appendLedger } from "../ledger.js";
import { saveStatus, type WorkerStatus } from "../status.js";
import { frontmostItermSession, headlessAllowed, resolveHostSession } from "../pane.js";
import { recordSystemWaiver, type SystemJob } from "../pane-waiver.js";
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
 * a typed system waiver, the operator's override, or workers.pane.enabled false; the command then runs directly.
 * `restart`: the run repeats an earlier one (reroute, fall-through); no terminal then runs it headless, not refused.
 * A pane that cannot be opened for any other reason rejects: the command does not run unseen.
 */
export async function requireVisiblePane(
  logDir: string,
  config: ReturnType<typeof readWorkersSection>["workers"],
  wid: string,
  term: string,
  systemWaiver: SystemJob | undefined,
  dryRun: boolean,
  ledger: string,
  restart = false
): Promise<boolean> {
  if (dryRun) return false;
  // the typed system waiver (daemon jobs) is the only per-start waiver; a caller's own "no pane" request does not exist any more
  if (systemWaiver) {
    recordSystemWaiver(ledger, systemWaiver, wid);
    process.stderr.write(`[pai worker] pane waived for ${wid}: system job ${systemWaiver}\n`);
    return false;
  }
  const waiver = paneWaiver(config);
  if (waiver) {
    appendLedger(ledger, "PANE-WAIVED", { id: wid, why: waiver });
    process.stderr.write(`[pai worker] pane waived for ${wid}: ${waiver}\n`);
    return false;
  }
  if (paneHandles.has(wid)) return true;
  const refuse = (reason: string): never => {
    appendLedger(ledger, "PANE-REFUSED", { id: wid, reason });
    process.stderr.write(`[pai worker] ${wid} not started: no pane: ${reason}\n`);
    throw new Error(`no pane: ${reason}`);
  };
  try {
    let pane: OwnedPane | null;
    try {
      pane = await launchPane({ logDir, config, id: wid, kind: "worker", term });
    } catch (e) {
      if (!restart) throw e;
      // the inherited session is gone (closed tab, iTerm restart): anchor to the operator's frontmost window, else run headless
      const err = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      process.stderr.write(`[pai worker] ${wid}: restart pane failed (${err}); trying the frontmost iTerm window\n`);
      pane = null;
      try {
        const front = await frontmostItermSession();
        if (front && front !== term) pane = await launchPane({ logDir, config, id: wid, kind: "worker", term: front });
      } catch (e2) {
        noTerminalReasons.set(wid, `${err}; frontmost window: ${(e2 instanceof Error ? e2.message : String(e2)).slice(0, 200)}`);
      }
      if (!pane && !noTerminalReasons.has(wid)) noTerminalReasons.set(wid, err);
    }
    if (!pane) {
      const why = noTerminalReasons.get(wid) ?? "no terminal to open one in";
      // a restart of an earlier run (reroute, fall-through) must not drop the work: with no terminal anywhere it runs headless
      if (!restart) return refuse(why);
      appendLedger(ledger, "PANE-WAIVED", { id: wid, kind: "restart", why });
      process.stderr.write(`[pai worker] pane waived for ${wid}: restart with ${why}\n`);
      return false;
    }
    paneHandles.set(wid, pane);
    process.stderr.write(`[pai worker] pane opened for ${wid}: ${pane.where}\n`);
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("no pane: ")) throw e;
    return refuse((e instanceof Error ? e.message : String(e)).slice(0, 300));
  }
}

/** Why this start may run without a pane (workers.panes.required false, or the operator's hidden-run override), else null. */
export function paneWaiver(config: { panes?: { required: boolean } }): string | null {
  if (config.panes?.required === false) return "workers.panes.required=false";
  return headlessAllowed();
}

/**
 * Start a run's command: inside the pane opened for it (the wrapper's child, output rendered there), or
 * directly when no pane owns this run (no terminal, interactive, override).
 */
export async function spawnOwned(
  wid: string,
  cmd: string[],
  o: { env: NodeJS.ProcessEnv; cwd: string; stdio: ["pipe" | "ignore", "pipe", "pipe" | "inherit"] | "inherit"; render?: "plain" | "stream"; title: string; statusLine?: StatusLineSpec; hold?: boolean }
): Promise<ReturnType<typeof spawn>> {
  const pane = paneHandles.get(wid);
  if (!pane || o.stdio === "inherit") return spawn(cmd[0], cmd.slice(1), { env: o.env, cwd: o.cwd, stdio: o.stdio });
  paneHandles.delete(wid);
  const proc = (await pane.start({ argv: cmd, cwd: o.cwd, env: o.env as Record<string, string | undefined>, stdin: o.stdio[0] === "pipe" ? "pipe" : "ignore", render: o.render ?? "plain", title: o.title, ...(o.statusLine ? { statusLine: o.statusLine } : {}), ...(o.hold ? { hold: true } : {}) })).asChild();
  if (o.stdio[2] === "inherit") proc.stderr?.pipe(process.stderr);
  return proc;
}

/**
 * Spawn options of the pane command that follows a pooled run. The wrapper pipes the follow's output, so
 * the status line and the input line are pinned by the wrapper (statusLine), not by the follow view.
 */
export function pooledFollowSpawn(wid: string, label: string | undefined, logDir: string, cwd: string): Parameters<typeof spawnOwned>[2] & { cwd: string } {
  return { env: process.env, cwd, stdio: ["ignore", "pipe", "pipe"], title: `${label ?? wid} (pooled)`, statusLine: { kind: "worker", id: wid, logDir } };
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
  systemWaiver: SystemJob | undefined,
  ledger: string,
  status?: WorkerStatus
): Promise<void> {
  // the decision is saved here, before the caller spawns the child: the audit reads it from the status file
  const setPane = (p: NonNullable<WorkerStatus["pane"]>): void => {
    if (!status) return;
    status.pane = p;
    saveStatus(logDir, status);
  };
  void term;
  if (paneHandles.has(wid)) {
    setPane({ opened: true, exec: true });
    return;
  }
  const why = noTerminalReasons.get(wid) ?? (systemWaiver ? `system job ${systemWaiver}` : headlessAllowed() ?? "no pane owns this run");
  if (status?.pane?.opened !== false) process.stderr.write(`[pai worker] no pane for ${wid}: ${why}\n`);
  setPane({ opened: false, reason: why });
  void ledger;
}

/** The terminal identity a run's pane anchors to: the one a restart inherits from the run it repeats, else this process's host session ("" = none). */
export async function runTerm(inherited?: string): Promise<string> {
  return inherited ? inherited : (await resolveHostSession()).term;
}
