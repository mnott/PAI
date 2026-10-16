/**
 * shared-checkout.ts — is a worker's non-worktree cwd a checkout other people
 * work in? Tree-rewriting git is only dangerous there; a private standalone
 * clone (an A/B arm, a scratch `git init`) holds only this worker's edits.
 *
 * Shared when any of: it has linked worktrees (`git worktree list` > 1), it
 * has a remote (the operator's checkout of a project; scratch clones have
 * none), or another live worker's status has the same realpath cwd.
 * Fails closed: anything unreadable counts as shared.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { loadStatuses, isLive, type WorkerStatus } from "../../../workers/status.js";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export interface SharedCheckoutProbe {
  cwd: string;
  /** This worker's own id (PAI_WORKER_ID), excluded from the live-worker check. */
  selfId?: string | null;
  /** Workers status directory; null when unresolvable. */
  logDir: string | null;
}

export function isSharedCheckout(p: SharedCheckoutProbe): boolean {
  const worktrees = git(p.cwd, ["worktree", "list", "--porcelain"]);
  if (worktrees === null) return true;
  if (worktrees.split("\n").filter((l) => l.startsWith("worktree ")).length > 1) return true;
  const remotes = git(p.cwd, ["remote"]);
  if (remotes === null || remotes !== "") return true;
  if (!p.logDir) return true;
  const top = real(git(p.cwd, ["rev-parse", "--show-toplevel"]) ?? p.cwd);
  let statuses: WorkerStatus[];
  try {
    statuses = loadStatuses(p.logDir);
  } catch {
    return true;
  }
  return statuses.some((s) => s.id !== p.selfId && isLive(s) && real(s.cwd) === top);
}
