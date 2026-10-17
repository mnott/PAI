/**
 * pai issue claim|release|claims — mark forge issues as being worked on
 * (assignee "claude" + label "in-progress"). Never closes an issue.
 */
import type { Command } from "commander";
import { err } from "../lib/utils.js";
import { formatStale, loadStatusConfig, upsertSection, writeSectionToForge } from "../../session/forge-sink.js";
import { issueClaim, issueClaims, issueStale } from "../../session/issue-claims.js";

function num(s: string): number {
  const n = Number(s.replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) throw new Error(`not an issue number: ${s}`);
  return n;
}

export function registerIssueCommands(cmd: Command): void {
  const run = (f: () => void) => {
    try { f(); } catch (e) {
      console.error(err("pai issue: ") + (e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    }
  };
  for (const [name, add] of [["claim", true], ["release", false]] as const) {
    cmd
      .command(`${name} <n>`)
      .description(`${add ? "Claim" : "Release"} forge issue <n> of this project (assignee claude + label in-progress)`)
      .option("--dry-run", "Print the requests that would modify the issue; send none")
      .action((n: string, opts: { dryRun?: boolean }) =>
        run(() => {
          const r = issueClaim(process.cwd(), num(n), add, { dryRun: opts.dryRun });
          if (opts.dryRun) console.log(`DRY RUN (nothing sent): ${r.message}`);
          else console.log(r.message);
          for (const p of r.planned) console.log(`  would ${p}`);
        }));
  }
  cmd
    .command("claims")
    .description("List open issues of this project carrying the in-progress label")
    .action(() =>
      run(() => {
        const rows = issueClaims(process.cwd());
        if (!rows.length) console.log("no claimed issues");
        for (const r of rows) console.log(`#${r.issue}  ${r.title}  [${r.assignees.join(", ")}]`);
      }));
  cmd
    .command("stale")
    .description("List open issues that landed in the integration branch (merged branch named by number, or a 'fixes #N' commit subject; plain mentions do not count) or are idle (report only; never closes)")
    .option("--days <n>", "Idle threshold in days", "7")
    .option("--json", "JSON output")
    .option("--dry-run", "Also show the handover-issue section the daemon would write; send nothing")
    .action((opts: { days: string; json?: boolean; dryRun?: boolean }) =>
      run(() => {
        const days = Number(opts.days);
        if (!Number.isFinite(days) || days < 0) throw new Error(`bad --days: ${opts.days}`);
        const rows = issueStale(process.cwd(), days);
        console.log(opts.json ? JSON.stringify(rows, null, 2) : formatStale(rows));
        if (opts.dryRun) {
          const w = writeSectionToForge(process.cwd(), loadStatusConfig(process.cwd()), formatStale(rows), "stale", { dryRun: true });
          console.log(`\nDRY RUN: would write into handover #${w.issue}:\n${upsertSection("", formatStale(rows), "stale")}`);
        }
      }));
}
