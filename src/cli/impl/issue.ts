/**
 * pai issue claim|release|claims — mark forge issues as being worked on
 * (assignee "claude" + label "in-progress"). Never closes an issue.
 */
import { err } from "../lib/utils.js";
import { formatStale, loadStatusConfig, upsertSection, writeSectionToForge } from "../../session/forge-sink.js";
import { issueClaim, issueClaims, issueStale } from "../../session/issue-claims.js";

function num(s: string): number {
  const n = Number(s.replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) throw new Error(`not an issue number: ${s}`);
  return n;
}

/** Runs f; a thrown error prints as `pai issue: <message>` and exits 1. */
function run(f: () => void): number {
  try {
    f();
    return 0;
  } catch (e) {
    console.error(err("pai issue: ") + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
}

function claimOrRelease(n: string, add: boolean, opts: { dryRun?: boolean }): number {
  return run(() => {
    const r = issueClaim(process.cwd(), num(n), add, { dryRun: opts.dryRun });
    if (opts.dryRun) console.log(`DRY RUN (nothing sent): ${r.message}`);
    else console.log(r.message);
    for (const p of r.planned) console.log(`  would ${p}`);
  });
}

export function issueClaimCmd(n: string, opts: { dryRun?: boolean }): number {
  return claimOrRelease(n, true, opts);
}

export function issueReleaseCmd(n: string, opts: { dryRun?: boolean }): number {
  return claimOrRelease(n, false, opts);
}

export function issueClaimsCmd(): number {
  return run(() => {
    const rows = issueClaims(process.cwd());
    if (!rows.length) console.log("no claimed issues");
    for (const r of rows) console.log(`#${r.issue}  ${r.title}  [${r.assignees.join(", ")}]`);
  });
}

export function issueStaleCmd(opts: { days?: string; json?: boolean; dryRun?: boolean }): number {
  return run(() => {
    const raw = opts.days ?? "7";
    const days = Number(raw);
    if (!Number.isFinite(days) || days < 0) throw new Error(`bad --days: ${raw}`);
    const rows = issueStale(process.cwd(), days);
    console.log(opts.json ? JSON.stringify(rows, null, 2) : formatStale(rows));
    if (opts.dryRun) {
      const w = writeSectionToForge(process.cwd(), loadStatusConfig(process.cwd()), formatStale(rows), "stale", { dryRun: true });
      console.log(`\nDRY RUN: would write into handover #${w.issue}:\n${upsertSection("", formatStale(rows), "stale")}`);
    }
  });
}
