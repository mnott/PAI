/** `pai tests audit|prune`: test governance for any repo (logic in src/testgov). */

import { resolve } from "node:path";
import { auditRepo, formatAudit } from "../../testgov/audit.js";
import { prune } from "../../testgov/prune.js";
import type { CommandDef, OptDef } from "../define.js";

const REPO: OptDef = { name: "repo", type: "string", value: "PATH", summary: "Repository (default: the current directory)" };
const repoOf = (v: unknown): string => resolve(typeof v === "string" ? v : process.cwd());

export const testsCommand: CommandDef = {
  name: "tests",
  summary: "Test governance: audit a repo's tests, prune them to the governed core",
  description:
    "Tests stay only with evidence (tests/KEPT.md): (a) a real fix they guarded, (b) a security or destructive-operation guard, (c) an external contract. " +
    "UI/simulator targets, snapshot baselines and run outputs (.xcresult, recordings, screenshots, DerivedData) are classified too; outputs are always dropped unless listed. " +
    "`audit` reads git and files only and never runs a test. `prune` prints the plan; with --apply a worker (orchestrate class) removes the rest on its own branch and commits; you land it. " +
    "The growth alarm (config tests.growthAlarm, default 20) tells the session when a project's suite outgrows its core or a gate run reports more than 500 tests.",
  examples: ["pai tests audit --repo .", "pai tests prune --repo ~/code/app", "pai tests prune --repo ~/code/app --apply"],
  seeAlso: ["pai worker merge"],
  subcommands: [
    {
      name: "audit",
      summary: "List test files with a proposed class and the file-count trend",
      description: "Per file: KEEP-a/b/c with evidence, or DROP; then test files per month and a proposed tests/KEPT.md. Read-only.",
      options: [REPO, { name: "all", type: "boolean", default: false, summary: "List every file (default: the first 60)" }, { name: "json", type: "boolean", default: false, summary: "Machine-readable JSON" }],
      examples: ["pai tests audit", "pai tests audit --repo ~/code/app --all"],
      run: (ctx) => {
        const a = auditRepo(repoOf(ctx.opts.repo));
        console.log(ctx.opts.json === true ? JSON.stringify(a, null, 2) : formatAudit(a, ctx.opts.all === true));
        return 0;
      },
    },
    {
      name: "prune",
      summary: "Plan, or with --apply start a worker, that prunes the suite to the governed core",
      description: "Without --apply prints the plan. With --apply starts `pai worker run --class orchestrate` in the repo: git rm the DROP files and test-only fixtures, write tests/KEPT.md, keep the test script and build working, one commit. It never merges.",
      options: [REPO, { name: "apply", type: "boolean", default: false, summary: "Start the worker (default: print the plan)" }],
      examples: ["pai tests prune", "pai tests prune --repo ~/code/app --apply"],
      run: (ctx) => {
        const r = prune(repoOf(ctx.opts.repo), ctx.opts.apply === true, { cmd: process.execPath, args: [process.argv[1] ?? "pai"] });
        console.log(r.lines.join("\n"));
        return 0;
      },
    },
  ],
};
