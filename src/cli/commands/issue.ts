/**
 * pai issue claim|release|claims — mark forge issues as being worked on
 * (assignee "claude" + label "in-progress"). Never closes an issue.
 */
import type { Command } from "commander";
import { err } from "../utils.js";
import { issueClaim, issueClaims } from "../../session/issue-claims.js";

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
}
