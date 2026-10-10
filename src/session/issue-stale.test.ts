import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listStale, formatStale, upsertSection, type Http, type Git } from "./forge-sink.js";
import { runStalePass } from "../daemon/stale-pass.js";

const CFG = { sink: "forge" as const, anchor: 1, marker: "ANCHOR" };
const ORIGIN = "https://forge.example/git/ORG/Proj.git";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const day = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const issue = (number: number, title: string, ageDays: number, extra: object = {}) => ({ number, title, updated_at: day(ageDays), ...extra });

function http(issues: object[], log: string[] = [], bodies: Record<number, string> = {}): Http {
  return (method, url, _t, body) => {
    log.push(`${method} ${url.split("/repos/ORG/Proj")[1]}${body ? ` ${body}` : ""}`);
    if (method === "GET" && url.includes("/issues?")) return { status: 200, text: JSON.stringify(issues) };
    const m = url.match(/\/issues\/(\d+)$/);
    if (method === "GET" && m) return { status: 200, text: JSON.stringify({ body: bodies[Number(m[1])] ?? "" }) };
    if (method === "GET") return { status: 200, text: JSON.stringify({ default_branch: "main" }) };
    return { status: 200, text: "{}" };
  };
}

const TIP = "aaa";
function fakeGit(o: { merged?: string[]; commits?: Record<number, string>; refs?: string[] }): Git {
  return (a) => {
    if (a[0] === "for-each-ref") return (o.refs ?? ["main", "origin/main"]).join("\n");
    if (a[0] === "rev-parse") return TIP;
    if (a[0] === "branch") return [`main ${TIP}`, ...(o.merged ?? []).map((b) => `${b} bbb`)].join("\n");
    const m = a.find((x) => x.startsWith("--grep="))!.match(/#(\d+)/)!;
    return o.commits?.[Number(m[1])] ?? "";
  };
}
const deps = (h: Http, g: Git) => ({ http: h, git: g, token: "tok", originUrl: ORIGIN, now: NOW });

describe("listStale", () => {
  it("landed via merged branch (worker/ and number- forms); trailing (#12) is not landed", () => {
    const rows = listStale("/x", CFG, 7, deps(
      http([issue(10, "a", 1), issue(11, "b", 1), issue(12, "c", 1), issue(13, "d", 1)]),
      fakeGit({ merged: ["origin/10-fix-a", "recovery/11"], commits: { 12: "abc123 feat: x (#12)" } }),
    ));
    expect(rows.map((r) => [r.issue, r.kind, r.via])).toEqual([
      [10, "landed", "origin/10-fix-a"], [11, "landed", "recovery/11"],
    ]);
  });
  it("never lists the configured anchor issue", () => {
    const rows = listStale("/x", CFG, 7, deps(http([issue(1, "anchor", 30), issue(2, "old", 30)]), fakeGit({ merged: ["worker/1-x"] })));
    expect(rows.map((r) => r.issue)).toEqual([2]);
  });
  it("mention-only commit, v12.1 and 112 branches are not landed; fixes #12 is", () => {
    const git: Git = (a) => (a[0] === "branch" ? `main ${TIP}\nfeat/v12.1 bbb\nfeat/112 bbb` : fakeGit({ commits: { 12: "abc see #12 anchor", 13: "def fixes #13", 14: "ghi Closes #14 now" } })(a));
    const rows = listStale("/x", CFG, 7, deps(http([issue(12, "a", 0), issue(13, "b", 0), issue(14, "c", 0)]), git));
    expect(rows.map((r) => [r.issue, r.via])).toEqual([[13, "commit def fixes #13"], [14, "commit ghi Closes #14 now"]]);
  });
  it("does not match #1 inside #10 and ignores a branch sitting at the tip", () => {
    const git: Git = (a) => (a[0] === "branch" ? `main ${TIP}\nworker/1-new ${TIP}\nfeat/10-x bbb` : fakeGit({})(a));
    const rows = listStale("/x", CFG, 7, deps(http([issue(1, "one", 0)]), git));
    expect(rows).toEqual([]);
  });
  it("idle threshold is inclusive; claim state shown", () => {
    const rows = listStale("/x", CFG, 7, deps(
      http([issue(1, "fresh", 6), issue(2, "edge", 7, { assignees: [{ login: "claude" }], labels: [{ id: 1, name: "in-progress" }] })]),
      fakeGit({}),
    ));
    expect(rows).toHaveLength(1);
    expect(formatStale(rows)).toBe("- #2 edge - idle 7 days [assignee claude, in-progress]");
  });
  it("orders landed first, then idle oldest first", () => {
    const rows = listStale("/x", CFG, 7, deps(
      http([issue(4, "i-new", 8), issue(2, "i-old", 30), issue(3, "l", 0)]),
      fakeGit({ merged: ["worker/3-z"] }),
    ));
    expect(rows.map((r) => r.issue)).toEqual([3, 2, 4]);
  });
  it("empty list formats as the no-stale line", () => {
    expect(formatStale([])).toBe("No stale issues.");
  });
});

describe("stale section", () => {
  it("replace keeps the rest of the body and never stacks", () => {
    const body = "intro\n<!-- pai:continue -->\nkeep\n<!-- /pai:continue -->\n\ntail\n";
    const once = upsertSection(body, "- #1 x", "stale");
    const twice = upsertSection(once, "No stale issues.", "stale");
    expect(twice.match(/<!-- pai:stale -->/g)).toHaveLength(1);
    expect(twice).toContain("intro\n<!-- pai:continue -->\nkeep\n<!-- /pai:continue -->\n\ntail\n");
    expect(twice).toContain("<!-- pai:stale -->\nNo stale issues.\n<!-- /pai:stale -->");
    expect(twice).not.toContain("#1 x");
  });
});

describe("runStalePass", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "stale-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const project = (name: string, yaml: string) => {
    const root = join(dir, name);
    mkdirSync(join(root, ".pai"), { recursive: true });
    writeFileSync(join(root, ".pai/project.yaml"), yaml);
    return root;
  };

  it("skips non-forge and unconfigured projects, writes forge ones, never closes", () => {
    const forge = project("f", "status:\n  sink: forge\n  forge:\n    anchor: 1\n    marker: ANCHOR\n");
    const todo = project("t", "status:\n  sink: todo\n");
    const bare = join(dir, "bare");
    mkdirSync(bare);
    const log: string[] = [];
    const h = http([issue(5, "old", 20)], log, { 1: "ANCHOR\nhandover: #2", 2: "body\n" });
    const msgs: string[] = [];
    const n = runStalePass([todo, bare, forge], { http: h, git: fakeGit({}), token: "tok", originUrl: ORIGIN, now: NOW }, (m) => msgs.push(m));
    expect(n).toBe(1);
    const patches = log.filter((l) => l.startsWith("PATCH"));
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("/issues/2");
    expect(patches[0]).toContain("pai:stale");
    expect(patches[0]).toContain("#5 old - idle 20 days");
    expect(log.some((l) => /^(DELETE|POST)/.test(l))).toBe(false);
  });
  it("a failing project is logged, not thrown", () => {
    const forge = project("f", "status:\n  sink: forge\n  forge:\n    anchor: 1\n    marker: ANCHOR\n");
    const bad: Http = () => ({ status: 500, text: "" });
    const msgs: string[] = [];
    expect(runStalePass([forge], { http: bad, git: fakeGit({}), token: "tok", originUrl: ORIGIN }, (m) => msgs.push(m))).toBe(0);
    expect(msgs[0]).toContain("skipped");
  });
  it("dry run sends no PATCH", () => {
    const forge = project("f", "status:\n  sink: forge\n  forge:\n    anchor: 1\n    marker: ANCHOR\n");
    const log: string[] = [];
    runStalePass([forge], { http: http([], log, { 1: "ANCHOR\nhandover: #2" }), git: fakeGit({}), token: "tok", originUrl: ORIGIN, dryRun: true }, () => {});
    expect(log.some((l) => l.startsWith("PATCH"))).toBe(false);
  });
});
