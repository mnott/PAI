/** `pai tests audit|prune`: test governance for any repo (logic in src/testgov). */

import { resolve } from "node:path";
import { auditRepo, formatAudit } from "../../testgov/audit.js";
import { appendKept } from "../../testgov/kept.js";
import { prune } from "../../testgov/prune.js";
import { CliError } from "../define.js";
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
    "The growth alarm (config tests.growthAlarm, default 20) counts test call sites — it()/test() definitions, not a runner's expanded cases — and tells the session when a project's suite outgrows its core or holds more than 500 of them. " +
    "`keep` appends exactly one row to tests/KEPT.md (or Tests/KEPT.md) — never rewrite the ledger by hand.",
  examples: ["pai tests audit --repo .", "pai tests prune --repo ~/code/app", "pai tests prune --repo ~/code/app --apply", 'pai tests keep tests/foo.test.ts --kind a --evidence "guarded the off-by-one in #123"'],
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
    {
      name: "keep",
      summary: "Append one evidence row to tests/KEPT.md for a test file",
      description:
        "Registers a kept test file in the governance ledger without touching the other rows: appends exactly one `| file | class | evidence |` row to tests/KEPT.md " +
        "(or Tests/KEPT.md), creating the file with its header when missing. Refuses a duplicate — it prints the existing row and writes nothing. " +
        "Never rewrite the ledger by hand: a wholesale rewrite drops rows.",
      args: [{ name: "TEST_FILE", summary: "Test file to register, relative to the repo (e.g. tests/foo.test.ts)", required: true }],
      options: [
        REPO,
        { name: "kind", type: "string", value: "a|b|c", summary: "Evidence class: a = guarded a real fix, b = security/destructive guard, c = external contract" },
        { name: "evidence", type: "string", value: "TEXT", summary: "One line: why this test stays" },
      ],
      examples: ['pai tests keep tests/foo.test.ts --kind a --evidence "guarded the off-by-one in #123"', "pai tests keep tests/sec.test.ts --kind b --evidence pins the destructive-op block"],
      seeAlso: ["pai tests audit"],
      run: (ctx) => {
        const file = ctx.args.TEST_FILE;
        if (!file || typeof file !== "string") throw new CliError("Give the test file to register.", "pai tests keep <test-file> --kind a|b|c --evidence \"<why>\"");
        const kind = typeof ctx.opts.kind === "string" ? ctx.opts.kind : "";
        if (!/^[abc]$/.test(kind)) throw new CliError(`--kind must be a, b or c (got "${kind || "none"}").`, "a = guarded a real fix, b = security/destructive guard, c = external contract");
        const evidence = typeof ctx.opts.evidence === "string" ? ctx.opts.evidence.trim() : "";
        if (!evidence) throw new CliError("Give --evidence: one line on why this test stays.", 'pai tests keep <test-file> --kind a --evidence "<why>"');
        const r = appendKept(repoOf(ctx.opts.repo), file, [kind], evidence);
        if (!r.added) {
          console.log(`Already registered: | ${r.existing!.file} | ${r.existing!.classes.join(",")} | ${r.existing!.evidence} |`);
          return 0;
        }
        console.log(`Added to ${r.path}: | ${r.row!.file} | ${r.row!.classes.join(",")} | ${r.row!.evidence} |`);
        return 0;
      },
    },
  ],
};
