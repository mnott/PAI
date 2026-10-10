/**
 * Status sink: write the session handover ("## Continue") into a forge issue
 * instead of Notes/TODO.md. Opt-in per project via `.pai/project.yaml`:
 *
 *   status:
 *     sink: forge            # todo (default) | forge
 *     forge:
 *       anchor: 283          # issue number of the anchor
 *       marker: CASELEAF-HANDOVER-ANCHOR-V1   # must occur in the anchor body
 *       repo: OWNER/NAME     # optional; default from `git remote get-url origin`
 *
 * Anchor format: the anchor body carries the line `handover: #<n>`, naming the
 * day's handover issue. If no such line exists, the first `#<n>` after the
 * marker is used. The handover issue body holds the section
 * `<!-- pai:continue --> ... <!-- /pai:continue -->`, replaced or appended.
 * Never comments, never closes. Token: config `forge.token`, else env
 * FORGE_TOKEN, else AIBROKER_FORGE_TOKEN; never printed.
 *
 * Synchronous (callers are hooks) via curl, 5 s budget for the whole write.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { projectRoot } from "../workers/preamble.js";
import { readMainConfigRaw } from "../daemon/config.js";

export const PROJECT_CONFIG_REL = ".pai/project.yaml";
export const SECTION_OPEN = "<!-- pai:continue -->";
export const SECTION_CLOSE = "<!-- /pai:continue -->";
export const FORGE_BUDGET_MS = 5000;

export interface StatusConfig {
  sink: "todo" | "forge";
  anchor?: number;
  marker?: string;
  repo?: string;
}

export interface HttpResult { status: number; text: string }
/** Injected in tests. Throws on transport failure. */
export type Http = (method: "GET" | "PATCH" | "POST" | "DELETE", url: string, token: string, body: string | undefined, timeoutMs: number) => HttpResult;

export class ForgeError extends Error {}

export function parseStatusConfig(text: string): StatusConfig {
  const doc = (parse(text) ?? {}) as { status?: { sink?: unknown; forge?: Record<string, unknown> } };
  const forge = doc.status?.forge ?? {};
  const anchor = Number(forge.anchor);
  return {
    sink: doc.status?.sink === "forge" ? "forge" : "todo",
    anchor: Number.isInteger(anchor) && anchor > 0 ? anchor : undefined,
    marker: typeof forge.marker === "string" && forge.marker ? forge.marker : undefined,
    repo: typeof forge.repo === "string" && forge.repo ? forge.repo : undefined,
  };
}

export function loadStatusConfig(cwd: string): StatusConfig {
  const path = join(projectRoot(cwd), PROJECT_CONFIG_REL);
  if (!existsSync(path)) return { sink: "todo" };
  try {
    return parseStatusConfig(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ForgeError(`${PROJECT_CONFIG_REL} unreadable (${(e as Error).message.split("\n")[0]})`);
  }
}

/** https://host/git/OWNER/REPO.git -> API base https://host/git/api/v1 + "OWNER/REPO". */
export function deriveRepo(originUrl: string): { apiBase: string; repo: string } {
  const m = originUrl.trim().match(/^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.*?)\/?$/);
  if (m) {
    const parts = m[3].replace(/\.git$/, "").split("/");
    if (parts.length >= 2) {
      const prefix = parts.slice(0, -2).join("/");
      return { apiBase: `${m[1]}://${m[2]}${prefix ? `/${prefix}` : ""}/api/v1`, repo: parts.slice(-2).join("/") };
    }
  }
  throw new ForgeError("cannot derive forge API from origin URL");
}

function resolveToken(): string | undefined {
  try {
    const t = (readMainConfigRaw().forge as { token?: unknown } | undefined)?.token;
    if (typeof t === "string" && t) return t;
  } catch { /* unreadable config: fall through to env */ }
  return process.env.FORGE_TOKEN || process.env.AIBROKER_FORGE_TOKEN || undefined;
}

/** Real transport: curl; the token goes in on stdin so it never shows in ps. */
export const curlHttp: Http = (method, url, token, body, timeoutMs) => {
  const cfg = [
    `url = "${url}"`,
    `request = "${method}"`,
    `header = "Authorization: token ${token}"`,
    `header = "Content-Type: application/json"`,
    `max-time = ${Math.max(0.5, timeoutMs / 1000)}`,
    `silent`,
    `write-out = "\\n%{http_code}"`,
  ].join("\n");
  const argv = body !== undefined ? ["-K", "-", "--data-raw", body] : ["-K", "-"];
  const r = spawnSync("curl", argv, { input: cfg, encoding: "utf8", timeout: timeoutMs + 500, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new ForgeError(`curl failed (${r.error?.message ?? `exit ${r.status}`})`);
  const at = r.stdout.lastIndexOf("\n");
  return { status: Number(r.stdout.slice(at + 1)), text: r.stdout.slice(0, at) };
};

/** `handover: #<n>` line wins; else the first `#<n>` after the marker. */
export function extractHandoverNumber(anchorBody: string, marker: string): number | undefined {
  const line = anchorBody.match(/^\s*handover:\s*#(\d+)/im);
  if (line) return Number(line[1]);
  const after = anchorBody.slice(anchorBody.indexOf(marker) + marker.length).match(/#(\d+)/);
  return after ? Number(after[1]) : undefined;
}

/** Replace the delimited section, or append it; everything else stays byte-identical. */
export function upsertSection(body: string, markdown: string): string {
  const section = `${SECTION_OPEN}\n${markdown.trim()}\n${SECTION_CLOSE}`;
  const a = body.indexOf(SECTION_OPEN);
  const b = a === -1 ? -1 : body.indexOf(SECTION_CLOSE, a);
  if (b !== -1) return body.slice(0, a) + section + body.slice(b + SECTION_CLOSE.length);
  const sep = body === "" || body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return body + sep + section + "\n";
}

export interface ForgeDeps { http?: Http; token?: string; originUrl?: string; dryRun?: boolean }

type Method = "GET" | "PATCH" | "POST" | "DELETE";

/** One forge repo + token + 5 s budget; dry run records mutating calls in `planned` instead of sending them. */
function forgeClient(cwd: string, cfg: StatusConfig, deps: ForgeDeps) {
  const token = deps.token ?? resolveToken();
  if (!token) throw new ForgeError("no forge token");
  const http = deps.http ?? curlHttp;
  let origin = deps.originUrl;
  if (!origin) {
    try {
      origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch { throw new ForgeError("no origin remote"); }
  }
  const derived = deriveRepo(origin);
  const repo = cfg.repo ?? derived.repo;
  const deadline = Date.now() + FORGE_BUDGET_MS;
  const planned: string[] = [];
  const call = (method: Method, path: string, body?: string): HttpResult => {
    if (deps.dryRun && method !== "GET") {
      planned.push(`${method} ${derived.apiBase}/repos/${repo}/${path}${body ? ` ${body}` : ""}`);
      return { status: 200, text: "{}" };
    }
    const left = deadline - Date.now();
    if (left < 300) throw new ForgeError("time budget exhausted");
    let r: HttpResult;
    try { r = http(method, `${derived.apiBase}/repos/${repo}/${path}`, token, body, left); }
    catch (e) { throw e instanceof ForgeError ? e : new ForgeError(`request failed (${(e as Error).message})`); }
    if (r.status < 200 || r.status >= 300) throw new ForgeError(`HTTP ${r.status} on ${method} ${path}`);
    return r;
  };
  return { repo, call, planned };
}

function json<T>(r: HttpResult): T {
  try { return JSON.parse(r.text) as T; } catch { throw new ForgeError("unparseable forge response"); }
}

/** Returns the issue number written (or, dry run, that would be). Throws ForgeError with the reason. */
export function writeContinueToForge(cwd: string, cfg: StatusConfig, markdown: string, deps: ForgeDeps = {}): { issue: number; body: string } {
  if (!cfg.anchor || !cfg.marker) throw new ForgeError("status.forge.anchor/marker missing");
  const { call } = forgeClient(cwd, cfg, deps);
  const bodyOf = (n: number): string => String(json<{ body?: unknown }>(call("GET", `issues/${n}`)).body ?? "");
  const anchorBody = bodyOf(cfg.anchor);
  if (!anchorBody.includes(cfg.marker)) throw new ForgeError(`anchor #${cfg.anchor} lacks marker`);
  const handover = extractHandoverNumber(anchorBody, cfg.marker);
  if (!handover) throw new ForgeError(`no handover number in anchor #${cfg.anchor}`);
  const next = upsertSection(bodyOf(handover), markdown);
  if (!deps.dryRun) call("PATCH", `issues/${handover}`, JSON.stringify({ body: next }));
  return { issue: handover, body: next };
}

// Claim convention (identical on the AIBroker side): assignee CLAIM_ASSIGNEE + label CLAIM_LABEL.
// PAI never closes issues.
export const CLAIM_ASSIGNEE = "claude";
export const CLAIM_LABEL = "in-progress";

export interface ClaimResult { repo: string; issue: number; message: string; planned: string[] }
export interface ClaimRecord { issue: number; repo: string; at: string }

interface IssueView { assignees?: Array<{ login: string }> | null; labels?: Array<{ id: number; name: string }> | null }

/** Claim (add=true) or release (add=false) issue `n`; other assignees and labels are left alone. */
export function setClaim(cwd: string, cfg: StatusConfig, n: number, add: boolean, deps: ForgeDeps = {}): ClaimResult {
  const { repo, call, planned } = forgeClient(cwd, cfg, deps);
  const issue = json<IssueView>(call("GET", `issues/${n}`));
  const logins = (issue.assignees ?? []).map((a) => a.login);
  const next = add ? [...new Set([...logins, CLAIM_ASSIGNEE])] : logins.filter((l) => l !== CLAIM_ASSIGNEE);
  if (next.length !== logins.length || next.some((l, i) => l !== logins[i])) {
    call("PATCH", `issues/${n}`, JSON.stringify({ assignees: next }));
  }
  const verb = add ? "claimed" : "released";
  let message = `${verb} ${repo}#${n}`;
  const has = (issue.labels ?? []).find((l) => l.name === CLAIM_LABEL);
  if (add && !has) {
    const label = json<Array<{ id: number; name: string }>>(call("GET", "labels?limit=100")).find((l) => l.name === CLAIM_LABEL);
    if (label) call("POST", `issues/${n}/labels`, JSON.stringify({ labels: [label.id] }));
    else message += ` (assignee only: label "${CLAIM_LABEL}" does not exist in ${repo})`;
  } else if (!add && has) {
    call("DELETE", `issues/${n}/labels/${has.id}`);
  }
  return { repo, issue: n, message, planned };
}

/** Open issues in the repo currently carrying the claim label. */
export function listClaims(cwd: string, cfg: StatusConfig, deps: ForgeDeps = {}): Array<{ issue: number; title: string; assignees: string[] }> {
  const { call } = forgeClient(cwd, cfg, deps);
  const rows = json<Array<{ number: number; title: string; pull_request?: unknown } & IssueView>>(
    call("GET", `issues?state=open&type=issues&labels=${CLAIM_LABEL}&limit=50`),
  );
  return rows.map((r) => ({ issue: r.number, title: r.title, assignees: (r.assignees ?? []).map((a) => a.login) }));
}

/** Release every claim best-effort; returns the per-issue errors (never throws). */
export function releaseClaims(cwd: string, claims: ClaimRecord[], deps: ForgeDeps = {}): string[] {
  const errors: string[] = [];
  for (const c of claims) {
    try { setClaim(cwd, { ...loadStatusConfig(cwd), repo: c.repo }, c.issue, false, deps); }
    catch (e) { errors.push(`${c.repo}#${c.issue}: ${(e as Error).message}`); }
  }
  return errors;
}
