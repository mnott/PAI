/**
 * `pai issue claim|release|claims`: the shared core of the CLI and the MCP
 * tools. Inside a worker (PAI_WORKER_ID) a claim is also recorded in that
 * worker's status, so saveStatus can release it when the worker ends.
 */
import { loadStatus, saveStatus } from "../workers/status.js";
import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { listClaims, loadStatusConfig, setClaim, type ForgeDeps } from "./forge-sink.js";

export interface IssueOpts extends ForgeDeps { logDir?: string; workerId?: string }

export function issueClaim(cwd: string, n: number, add: boolean, o: IssueOpts = {}): { message: string; planned: string[] } {
  const r = setClaim(cwd, loadStatusConfig(cwd), n, add, o);
  const wid = o.workerId ?? process.env.PAI_WORKER_ID;
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
