/**
 * `pai issue claim|release|claims`: the shared core of the CLI and the MCP
 * tools. Inside a worker (PAI_WORKER_ID) a claim is also recorded in that
 * worker's status, so saveStatus can release it when the worker ends.
 */
import { currentWorkerId } from "../workers/worker-id.js";
import { loadStatus, saveStatus } from "../workers/status.js";
import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { listClaims, listStale, loadStatusConfig, setClaim, type ForgeDeps, type StaleDeps } from "./forge-sink.js";

export interface IssueOpts extends ForgeDeps { logDir?: string; workerId?: string }

export function issueClaim(cwd: string, n: number, add: boolean, o: IssueOpts = {}): { message: string; planned: string[] } {
  const r = setClaim(cwd, loadStatusConfig(cwd), n, add, o);
  const wid = o.workerId ?? currentWorkerId(process.env, o.logDir);
  if (wid && !o.dryRun) {
    const logDir = o.logDir ?? workersLogDir(readWorkersSection().workers);
    const st = loadStatus(logDir, wid);
    if (st) {
      const rest = (st.claims ?? []).filter((c) => !(c.issue === n && c.repo === r.repo));
      st.claims = add ? [...rest, { issue: n, repo: r.repo, at: new Date().toISOString() }] : rest;
      saveStatus(logDir, st);
    }
  }
  return r;
}

export function issueClaims(cwd: string, o: IssueOpts = {}) {
  return listClaims(cwd, loadStatusConfig(cwd), o);
}

export function issueStale(cwd: string, days = 7, o: StaleDeps = {}) {
  return listStale(cwd, loadStatusConfig(cwd), days, o);
}
