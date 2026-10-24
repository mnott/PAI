/** The result table shared by `pai find` and the resume-by-query picker (rows from history search). */

import chalk from "chalk";
import type { SessionMatch } from "./history-search.js";
import { dim } from "./utils.js";

export const HISTORY_TABLE_HEADERS = ["#", "id", "when", "project", "last matching prompt"];

export function fmtTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Keep the tail of a project path (the meaningful part), prefixed with …. */
export function shortenProject(p: string, maxLen = 44): string {
  if (!p || p.length <= maxLen) return p || dim("—");
  return "…" + p.slice(-(maxLen - 1));
}

export function historyMatchRows(
  matches: SessionMatch[],
  o: { noSessionId: string; projectMax: number; noProject: string },
): string[][] {
  return matches.map((m, idx) => {
    const shortId = (m.sessionId ?? o.noSessionId).slice(0, 8);
    const when = m.lastMatchTs > 0 ? fmtTs(m.lastMatchTs) : dim("—");
    const project = shortenProject(m.project || o.noProject, o.projectMax);
    const fullSnippet = m.lastMatchDisplay.replace(/\n+/g, " ").trim();
    const snippet = fullSnippet.slice(0, 48);
    const display = snippet.length < fullSnippet.length ? `"${snippet}…"` : `"${snippet}"`;
    return [dim(String(idx + 1)), chalk.cyan(shortId), when, dim(project), chalk.dim(display)];
  });
}
