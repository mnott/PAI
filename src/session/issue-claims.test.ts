import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setClaim, releaseClaims, type Http } from "./forge-sink.js";
import { issueClaim } from "./issue-claims.js";
import { loadStatus, saveStatus, type WorkerStatus } from "../workers/status.js";

const CFG = { sink: "todo" as const };
const ORIGIN = "https://forge.example/git/ORG/Proj.git";
const BASE = "https://forge.example/git/api/v1/repos/ORG/Proj";

interface Issue { assignees: string[]; labels: Array<{ id: number; name: string }> }
function fake(issue: Issue, repoLabels: Array<{ id: number; name: string }>, log: string[] = [], failOn?: string): Http {
  return (method, url, _t, body) => {
    log.push(`${method} ${url.replace(BASE, "")}${body ? ` ${body}` : ""}`);
    if (failOn && url.includes(failOn)) return { status: 500, text: "" };
    if (method === "GET" && url.endsWith("/labels?limit=100")) return { status: 200, text: JSON.stringify(repoLabels) };
    if (method === "GET") return { status: 200, text: JSON.stringify({ assignees: issue.assignees.map((login) => ({ login })), labels: issue.labels }) };
    return { status: 200, text: "{}" };
  };
}
const deps = (http: Http) => ({ http, token: "tok", originUrl: ORIGIN });

describe("setClaim", () => {
  it("claim adds assignee and label without dropping others", () => {
    const log: string[] = [];
    const r = setClaim("/x", CFG, 7, true, deps(fake({ assignees: ["alice"], labels: [{ id: 1, name: "bug" }] }, [{ id: 9, name: "in-progress" }], log)));
    expect(log).toContain('PATCH /issues/7 {"assignees":["alice","claude"]}');
    expect(log).toContain('POST /issues/7/labels {"labels":[9]}');
    expect(r.message).toBe("claimed ORG/Proj#7");
  });
  it("release removes only ours", () => {
    const log: string[] = [];
    setClaim("/x", CFG, 7, false, deps(fake({ assignees: ["alice", "claude"], labels: [{ id: 1, name: "bug" }, { id: 9, name: "in-progress" }] }, [], log)));
    expect(log).toContain('PATCH /issues/7 {"assignees":["alice"]}');
    expect(log).toContain("DELETE /issues/7/labels/9");
    expect(log.some((l) => l.includes("/labels/1"))).toBe(false);
  });
  it("missing label: assignee only, says so", () => {
    const log: string[] = [];
    const r = setClaim("/x", CFG, 7, true, deps(fake({ assignees: [], labels: [] }, [{ id: 1, name: "bug" }], log)));
    expect(log.some((l) => l.startsWith("POST"))).toBe(false);
    expect(log.some((l) => l.startsWith("PATCH"))).toBe(true);
    expect(r.message).toContain('label "in-progress" does not exist');
  });
  it("dry run sends no mutation and reports it", () => {
    const log: string[] = [];
    const r = setClaim("/x", CFG, 7, true, { ...deps(fake({ assignees: [], labels: [] }, [{ id: 9, name: "in-progress" }], log)), dryRun: true });
    expect(log.every((l) => l.startsWith("GET"))).toBe(true);
    expect(r.planned).toHaveLength(2);
  });
});

describe("worker records and end release", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claims-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const status = (over: Partial<WorkerStatus> = {}): WorkerStatus => ({
    id: "w1", pid: 1, label: "l", cwd: dir, term: "", provider: "p", model: "m", state: "running",
    started: "", updated: "", turns: 0, tools: 0, last: "", rc: null, secs: null, ...over,
  } as WorkerStatus);
  const http = () => fake({ assignees: ["claude"], labels: [{ id: 9, name: "in-progress" }] }, []);

  it("records the claim in the worker status, none outside a worker", () => {
    saveStatus(dir, status());
    issueClaim(dir, 7, true, { ...deps(http()), workerId: "w1", logDir: dir });
    expect(loadStatus(dir, "w1")!.claims).toMatchObject([{ issue: 7, repo: "ORG/Proj" }]);
    const none = process.env.PAI_WORKER_ID;
    delete process.env.PAI_WORKER_ID;
    expect(() => issueClaim(dir, 8, true, { ...deps(http()), logDir: dir })).not.toThrow();
    expect(loadStatus(dir, "w1")!.claims).toHaveLength(1);
    if (none) process.env.PAI_WORKER_ID = none;
  });

  it("releaseClaims records failures instead of throwing", () => {
    const errs = releaseClaims(dir, [{ issue: 7, repo: "ORG/Proj", at: "" }], deps(fake({ assignees: ["claude"], labels: [] }, [], [], "issues/7")));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("ORG/Proj#7");
  });

  const claimed = (over: Partial<WorkerStatus>) =>
    status({ claims: [{ issue: 7, repo: "ORG/Proj", at: "" }], ...over });

  it("end path releases (failure recorded, not thrown); a continuing worker keeps its claims", () => {
    const quiet = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      // no git origin in the temp dir: the release fails, which must be recorded
      saveStatus(dir, claimed({ state: "done" }));
      const ended = loadStatus(dir, "w1")!;
      expect(ended.claims).toEqual([]);
      expect(ended.claimReleaseErrors?.[0]).toContain("ORG/Proj#7");

      saveStatus(dir, claimed({ state: "done", claimsContinue: true }));
      const kept = loadStatus(dir, "w1")!;
      expect(kept.claims).toHaveLength(1);
      expect(kept.claimReleaseErrors).toBeUndefined();
    } finally {
      process.stderr.write = quiet;
    }
  });
});
