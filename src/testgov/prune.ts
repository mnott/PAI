/**
 * prune.ts — `pai tests prune`: the plan from the audit, and with --apply a
 * worker in the repo that carries it out on its own branch (never merged).
 */

import { spawnSync } from "node:child_process";
import { auditRepo, type Audit } from "./audit.js";

export function pruneSpec(a: Audit): string {
  const drop = a.rows.filter((r) => r.verdict === "DROP");
  const keep = a.rows.filter((r) => r.verdict !== "DROP");
  return [
    `Prune the test suite of this repo (${a.repo}) to the governed core. Do not merge, push or touch the main branch; commit on your worker branch only.`,
    "",
    "Governance: a test file stays only with evidence. (a) a real product bug it guarded, (b) it pins a security guard or destructive-operation block, (c) it pins an external contract (wire format, schema migration, CLI output, docs-sync). Visual-app run outputs (.xcresult, recordings, screenshots, DerivedData) and simulator run scripts are one-time and are scratched unless listed in tests/KEPT.md.",
    "",
    `Audit: ${a.rows.length} test-related files (${a.totalTests} tests); keep ${keep.length} (support files stay), drop ${drop.length}.`,
    "",
    "Steps:",
    "1. `git rm` every DROP file below (rm the untracked ones), plus fixtures, helpers, mocks and snapshot baselines that only the dropped tests used (check with grep first). Remove emptied directories.",
    "2. Write tests/KEPT.md with exactly the KEEP rows below (keep the header text). Re-check each KEEP row against the file: drop a row whose evidence you cannot confirm.",
    "3. Keep the project's test script (package.json scripts.test, Makefile, xcodebuild scheme or equivalent) working on the kept core only; remove references to deleted targets/files (e.g. a UI test target in the Xcode project or CI workflow) so build and typecheck still pass.",
    "4. Run the typecheck/build (never the full suite of a mobile simulator). Prove they pass.",
    '5. ONE commit: "chore: prune the test suite to the governed core". No attribution lines.',
    "",
    "KEEP (write these to tests/KEPT.md):",
    a.proposedKept,
    "DROP:",
    ...drop.map((r) => `- ${r.file}`),
  ].join("\n");
}

export interface PruneResult {
  audit: Audit;
  lines: string[];
  started: boolean;
}

export function prune(repo: string, apply: boolean, cli: { cmd: string; args: string[] } = { cmd: "pai", args: [] }): PruneResult {
  const audit = auditRepo(repo);
  const drop = audit.rows.filter((r) => r.verdict === "DROP");
  const lines = [
    `prune plan for ${repo}: drop ${drop.length} of ${audit.rows.length} test files, keep ${audit.rows.length - drop.length} incl. support files (${audit.coreTests} tests)`,
    ...drop.slice(0, 40).map((r) => `  drop ${r.file}`),
    ...(drop.length > 40 ? [`  … ${drop.length - 40} more`] : []),
  ];
  if (!apply) return { audit, lines: [...lines, "dry run: pass --apply to start the worker (it commits on its own branch; you land it)"], started: false };
  if (!drop.length) return { audit, lines: [...lines, "nothing to prune"], started: false };
  const r = spawnSync(
    cli.cmd,
    [...cli.args, "worker", "run", "--class", "orchestrate", "--label", "prune the test suite", "-p", pruneSpec(audit), "--allowedTools", "Read,Edit,Write,Bash,Grep,Glob"],
    { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-6);
  return { audit, lines: [...lines, r.status === 0 ? "worker started:" : `worker start failed (exit ${r.status}):`, ...out], started: r.status === 0 };
}
