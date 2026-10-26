/**
 * audit.ts — `pai tests audit`: list a repo's test files with a proposed
 * governance class (KEEP-a/b/c or DROP) from git history and file reads
 * only; it never runs a test.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readKept, renderKept, type KeptEntry } from "./kept.js";

export interface AuditRow {
  file: string;
  /** KEEP-a / KEEP-b / KEEP-c combos ("a,b"), or "" for DROP. */
  classes: string[];
  verdict: string;
  evidence: string;
  tests: number;
  kind: Kind;
  /** Already registered in tests/KEPT.md. */
  registered: boolean;
}

export interface Audit {
  repo: string;
  rows: AuditRow[];
  /** Test count of the kept files. */
  coreTests: number;
  totalTests: number;
  /** Cumulative tracked test files at each month end. */
  trend: { month: string; files: number }[];
  proposedKept: string;
}

const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]*\.py$|_test\.py$|_test\.go$/;
const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//;
const SKIP = /(^|\/)(node_modules|\.pai-scratch|dist|vendor|\.build|Pods)\//;

// Visual-app testing: UI test targets, snapshot baselines, simulator scripts.
const UI_TARGET = /(^|\/)[^/]*UITests?\/|^(?!.*(^|\/)(Sources|src|main)\/).*(^|\/)[^/]*(UITests?|Tests)\.(swift|m|kt|java)$|(^|\/)androidTest\//;
const SNAPSHOT = /(^|\/)(__Snapshots__|__snapshots__|ReferenceImages|FailureDiffs|snapshots?)\/|\.snap$/;
const SIM_SCRIPT = /(^|\/)[^/]*(simulator|simctl|xcodebuild-test|ui-?tests?|uitest|snapshot)[^/]*\.(sh|py|rb|mjs|js)$/i;
/** Run outputs: result bundles, recordings, screenshots, DerivedData. Always DROP unless listed in KEPT.md. */
const ARTEFACT = /\.(xcresult|xcarchive)(\/|$)|(^|\/)DerivedData\/|\.(mov|mp4|m4v|gif|webm)$|(^|\/)(screenshots?|recordings?|TestResults?|test-results|playwright-report|Attachments)\//i;
const RUN_IMAGE = /(^|\/)(tests?|UITests?|e2e|__tests__)\/.*\.(png|jpe?g)$|(^|\/)[^/]*(screenshot|recording)[^/]*\.(png|jpe?g)$/i;

export const isArtefactPath = (f: string): boolean => !SKIP.test(f) && (ARTEFACT.test(f) || (RUN_IMAGE.test(f) && !SNAPSHOT.test(f)));
export const isTestPath = (f: string): boolean =>
  !SKIP.test(f) && !/(^|\/)tests\/KEPT\.md$/.test(f) && (TEST_FILE.test(f) || TEST_DIR.test(f) || UI_TARGET.test(f) || SNAPSHOT.test(f) || SIM_SCRIPT.test(f) || isArtefactPath(f));

export type Kind = "test" | "ui" | "snapshot" | "script" | "artefact";
export function kindOf(f: string): Kind {
  if (isArtefactPath(f)) return "artefact";
  if (SNAPSHOT.test(f)) return "snapshot";
  if (SIM_SCRIPT.test(f)) return "script";
  if (UI_TARGET.test(f)) return "ui";
  return "test";
}

const git = (repo: string, args: string[]): string => {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

const B_PATH = /secur|guard|safe|destruct|credential|token|secret|permission|sanitiz|sandbox|auth|inject|traversal|escape|rbac|acl|csrf|xss/i;
const B_BODY = /rm -rf|force[- ]push|path traversal|DROP TABLE|sql injection/i;
const C_PATH = /wire|schema|migrat|contract|snapshot|golden|docs?-sync|docs-keys|openapi|protocol|serializ|cli-output|api-compat/i;

/** Counted by pattern: it(/test( in JS/TS, def test_ in Python, func Test in Go. */
export function countTests(text: string): number {
  const js = text.match(/(^|[^\w.])(it|test)(\.(each|only|skip))?\s*(\(|\`)/gm)?.length ?? 0;
  const py = text.match(/^\s*(async )?def test_/gm)?.length ?? 0;
  const go = text.match(/^func Test\w+\(/gm)?.length ?? 0;
  const swift = text.match(/^\s*func test\w*\(/gm)?.length ?? 0;
  return js + py + go + swift;
}

interface Commit {
  hash: string;
  subject: string;
  month: string;
  files: { status: string; file: string }[];
}

function history(repo: string): Commit[] {
  const raw = git(repo, ["log", "--reverse", "--name-status", "--no-renames", "--date=format:%Y-%m", "--format=@@%h%x09%ad%x09%s"]);
  const commits: Commit[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      const [hash, month, ...s] = line.slice(2).split("\t");
      commits.push({ hash, month, subject: s.join("\t"), files: [] });
    } else if (line && commits.length) {
      const [status, ...f] = line.split("\t");
      commits[commits.length - 1].files.push({ status, file: f.join("\t") });
    }
  }
  return commits;
}

const FIX = /^(fix|hotfix)(\(.*\))?!?:/i;

export function auditRepo(repo: string): Audit {
  const kept = new Map<string, KeptEntry>(readKept(repo).map((k) => [k.file, k]));
  // tracked plus untracked-not-ignored: run outputs often sit untracked in the tree
  const listed = new Set([...git(repo, ["ls-files", "-z"]).split("\0"), ...git(repo, ["ls-files", "-z", "-o", "--exclude-standard"]).split("\0")]);
  const tracked = [...listed].filter((f) => f && isTestPath(f));
  const commits = history(repo);

  // fix evidence: a commit named fix that touched the file and also non-test code
  const fixes = new Map<string, string[]>();
  const live = new Set<string>();
  const trend: { month: string; files: number }[] = [];
  for (const c of commits) {
    for (const { status, file } of c.files) {
      if (!isTestPath(file)) continue;
      if (status.startsWith("D")) live.delete(file);
      else live.add(file);
    }
    if (FIX.test(c.subject) && c.files.length <= 30 && c.files.some((f) => !isTestPath(f.file) && !f.status.startsWith("D"))) {
      for (const f of c.files) if (isTestPath(f.file) && !f.status.startsWith("D")) fixes.set(f.file, [...(fixes.get(f.file) ?? []), c.hash]);
    }
    if (trend.length && trend[trend.length - 1].month === c.month) trend[trend.length - 1].files = live.size;
    else trend.push({ month: c.month, files: live.size });
  }

  const runnerText = ["vitest.config.ts", "vitest.config.js", "jest.config.js", "jest.config.ts", "package.json", "bunfig.toml", "pytest.ini", "pyproject.toml"]
    .map((f) => (existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : ""))
    .join("\n");
  const rows: AuditRow[] = tracked.map((file) => {
    const kind = kindOf(file);
    const text = (kind === "test" || kind === "ui" || kind === "script") && existsSync(join(repo, file)) ? readFileSync(join(repo, file), "utf8") : "";
    const tests = countTests(text);
    const reg = kept.get(file);
    // setup files in a test dir that the runner config points at belong to the kept core
    if (!reg && kind === "test" && !TEST_FILE.test(file) && runnerText.includes(file.split("/").pop()!.replace(/\.[a-z]+$/, ""))) {
      return { file, kind, classes: [], verdict: "SUPPORT", evidence: "named by the test runner config", tests, registered: false };
    }
    if (reg) return { file, kind, classes: reg.classes, verdict: `KEEP-${reg.classes.join(",")}`, evidence: reg.evidence, tests, registered: true };
    if (kind === "artefact") return { file, kind, classes: [], verdict: "DROP", evidence: "run output (not listed in KEPT.md)", tests: 0, registered: false };
    const classes: string[] = [];
    const ev: string[] = [];
    const fx = fixes.get(file);
    if (fx) {
      classes.push("a");
      ev.push(`fix commits ${fx.slice(-3).join(", ")}`);
    }
    if (B_PATH.test(file) || B_BODY.test(text)) {
      classes.push("b");
      ev.push("guard/security by path or content");
    }
    if (C_PATH.test(file)) {
      classes.push("c");
      ev.push("external contract by path");
    }
    return { file, kind, classes, verdict: classes.length ? `KEEP-${classes.join(",")}` : "DROP", evidence: ev.join("; "), tests, registered: false };
  });
  rows.sort((x, y) => x.file.localeCompare(y.file));
  const keep = rows.filter((r) => r.classes.length);
  return {
    repo,
    rows,
    coreTests: keep.reduce((n, r) => n + r.tests, 0),
    totalTests: rows.reduce((n, r) => n + r.tests, 0),
    trend,
    proposedKept: renderKept(keep.map((r) => ({ file: r.file, classes: r.classes, evidence: r.evidence }))),
  };
}

export function formatAudit(a: Audit, full = false): string {
  const keep = a.rows.filter((r) => r.classes.length);
  const support = a.rows.filter((r) => r.verdict === "SUPPORT").length;
  const lines = [`tests audit: ${a.repo}`, `${a.rows.length} test files (${a.totalTests} tests): ${keep.length} keep (${a.coreTests} tests), ${support} support, ${a.rows.length - keep.length - support} drop`, ""];
  const show = full ? a.rows : a.rows.slice(0, 60);
  for (const r of show) lines.push(`${r.verdict.padEnd(12)} ${String(r.tests).padStart(4)}  ${r.file}${r.evidence ? `  — ${r.evidence}` : ""}`);
  if (show.length < a.rows.length) lines.push(`… ${a.rows.length - show.length} more (use --all or --json)`);
  lines.push("", "test files per month (tracked, cumulative):", ...a.trend.slice(-12).map((t) => `  ${t.month}  ${t.files}`), "", "proposed tests/KEPT.md:", a.proposedKept);
  return lines.join("\n");
}
