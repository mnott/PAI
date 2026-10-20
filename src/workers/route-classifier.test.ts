import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLedger } from "./ledger.js";
import { loadChecks, localContract, taskForProvider, withLocalContract } from "./local-contract.js";
import { parsePlan } from "./plan.js";
import type { StartRequest, WorkerOutcome, RunLogEntry, RunnerDeps } from "./plan-runner.js";
import { runPlan } from "./plan-runner.js";
import { classifyRoute, localFailures, routeLine } from "./route-classifier.js";
import { resolveTarget, type TargetDeps } from "./target.js";

describe("classifyRoute", () => {
  it("sends cloud kinds to cloud and code/test kinds local", () => {
    for (const kind of ["infra", "install", "device", "external", "redesign"]) expect(classifyRoute({ kind }).where).toBe("cloud");
    for (const kind of ["code", "test"]) expect(classifyRoute({ kind, text: "install the thing" }).where).toBe("local");
  });
  it("matches keywords in the task text", () => {
    for (const text of ["fix TestFlight upload", "notarize the app", "iCloud sync bug", "CloudKit schema", "the build system", "build door run", "cut a release", "migrate the db", "redesign the cache", "App Store signing"]) {
      expect(classifyRoute({ text }).where, text).toBe("cloud");
    }
    expect(classifyRoute({ text: "fix the off-by-one in parseRange" })).toEqual({ where: "local", reason: "bounded code task" });
  });
  it("keeps release/door/CI keywords narrow", () => {
    for (const text of ["release notes typo in README", "explain the CIrcuit breaker"]) expect(classifyRoute({ text }).where, text).toBe("local");
    for (const text of ["cut the 1.4 release", "fix the build door's lock", "CI is red on main"]) expect(classifyRoute({ text }).where, text).toBe("cloud");
  });
  it("reads labels and tags", () => {
    expect(classifyRoute({ label: "infra: cache layout" }).where).toBe("cloud");
    expect(classifyRoute({ tags: ["device"] }).where).toBe("cloud");
  });
  it("formats the decision line", () => {
    expect(routeLine(classifyRoute({ kind: "install" }))).toBe("route: cloud (install/device task)");
  });
  it("force-local overrides every rule, including escalation", () => {
    expect(classifyRoute({ kind: "infra", text: "install", failures: 5, forceLocal: true }).where).toBe("local");
  });
  it("escalates after 2 failures, not after 1", () => {
    expect(classifyRoute({ text: "fix parser", failures: 1 }).where).toBe("local");
    const d = classifyRoute({ text: "fix parser", failures: 2 });
    expect(d.where).toBe("cloud");
    expect(d.reason).toContain("2 failed local attempts");
  });
});

describe("localFailures", () => {
  it("counts failed local ends of a label and resets on success", () => {
    const f = join(mkdtempSync(join(tmpdir(), "rc-")), "ledger.log");
    const end = (rc: number, provider = "flash", label = "part x") => appendLedger(f, "WORKER-END", { id: "w", provider, rc, label });
    end(1); end(143); end(1, "anthropic");
    const isLocal = (p: string) => p === "flash";
    expect(localFailures(f, "part x", isLocal)).toBe(2);
    end(0);
    expect(localFailures(f, "part x", isLocal)).toBe(0);
    end(1, "flash", "other");
    expect(localFailures(f, "part x", isLocal)).toBe(0);
  });
});

describe("resolveTarget routing", () => {
  const prov = (baseUrl: string, d: string) => ({ enabled: true, protocol: "anthropic" as const, baseUrl, keyFile: null, env: {}, models: { default: d } });
  const workers = { active: "glm", providers: { glm: prov("https://glm.example.invalid", "g"), flash: prov("http://127.0.0.1:8035", "flash-m") } } as unknown as TargetDeps["workers"];
  const deps = (over: Partial<TargetDeps> = {}): TargetDeps => ({ workers, logDir: mkdtempSync(join(tmpdir(), "tg-")), check: async () => true, env: {}, localFailures: () => 0, ...over });

  it("--where local with an install task goes to cloud and says why", async () => {
    const t = await resolveTarget({ where: "local", task: "fix the TestFlight upload" }, deps());
    expect(t.provider).toBe("glm");
    expect(t.description).toContain("route: cloud (install/signing task)");
  });
  it("a bounded code task stays local; force_local keeps an install task local", async () => {
    expect((await resolveTarget({ where: "local", task: "fix parseRange" }, deps())).provider).toBe("flash");
    expect((await resolveTarget({ where: "local", task: "TestFlight", forceLocal: true }, deps())).provider).toBe("flash");
  });
  it("no task context: today's behaviour", async () => {
    expect((await resolveTarget({ where: "local" }, deps())).provider).toBe("flash");
  });
  it("escalates a label after 2 local failures", async () => {
    expect((await resolveTarget({ where: "local", label: "p1", task: "fix parseRange" }, deps({ localFailures: () => 2 }))).provider).toBe("glm");
    expect((await resolveTarget({ where: "local", label: "p1", task: "fix parseRange" }, deps({ localFailures: () => 1 }))).provider).toBe("flash");
  });
});

describe("plan runner routing", () => {
  const mk = (kind: string) =>
    parsePlan(`job: j\nrepo: /r\ngate: g\nprovider: local\nunits:\n  - id: u\n    parts:\n      - {id: a, spec: do it, files: [f], kind: ${kind}}\n`, "/x");
  const run = async (kind: string, ok: (r: StartRequest) => boolean, opts: { forceLocal?: boolean } = {}) => {
    const log: RunLogEntry[] = [];
    const starts: string[] = [];
    const deps: RunnerDeps = {
      now: () => 0,
      resolveLocal: async (p) => p,
      log: (e) => log.push(e),
      async startWorker(r): Promise<WorkerOutcome> {
        starts.push(`${r.tier}:${r.provider}`);
        return { id: "w", ok: ok(r), failure: "boom" };
      },
      async merge() { return { ok: true, commit: "c2", before: "c1", output: "" }; },
      async unitCheck() { return { ok: true, output: "" }; },
    };
    await runPlan(mk(kind), { parallel: 1, escalate: false, ...opts, merged: new Set(), unitsChecked: new Set() } as never, deps);
    return { starts, log };
  };
  it("a cloud kind starts on the cloud tier", async () => {
    const r = await run("install", () => true);
    expect(r.starts).toEqual(["sonnet:anthropic"]);
    expect(r.log.find((e) => e.event === "route")?.note).toBe("route: cloud (install/device task)");
  });
  it("a code part fails twice locally, then the next start is cloud, without --escalate", async () => {
    const r = await run("code", (q) => q.tier === "sonnet");
    expect(r.starts).toEqual(["local:local", "local:local", "sonnet:anthropic"]);
  });
  it("forceLocal keeps an install part local and never escalates", async () => {
    const r = await run("install", () => false, { forceLocal: true });
    expect(r.starts).toEqual(["local:local", "local:local"]);
  });
});

describe("local worker contract", () => {
  it("is short and names the project's checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "chk-"));
    expect(loadChecks(dir)).toEqual({});
    execSyncMkdir(dir);
    writeFileSync(join(dir, ".pai/checks.yaml"), "fast: npx tsc --noEmit\ntest_one: npx vitest run {class}\n");
    const c = localContract(loadChecks(dir));
    expect(c).toContain("npx tsc --noEmit");
    expect(c).toContain("npx vitest run {class}");
    expect(c.split(/\s+/).length).toBeLessThan(120);
    expect(withLocalContract("TASK", dir).endsWith("\n\nTASK")).toBe(true);
  });
});

describe("contract only for local workers", () => {
  const p = (baseUrl: string) => ({ enabled: true, protocol: "anthropic", baseUrl, keyFile: null, env: {}, models: { default: "m" } }) as never;
  it("prepends on a loopback provider, not on a cloud one", () => {
    const dir = mkdtempSync(join(tmpdir(), "chk-"));
    expect(taskForProvider("TASK", p("http://127.0.0.1:8035"), dir)).toContain("Local worker rules");
    expect(taskForProvider("TASK", p("https://glm.example.invalid"), dir)).toBe("TASK");
  });
});

import { mkdirSync } from "node:fs";
function execSyncMkdir(dir: string) {
  mkdirSync(join(dir, ".pai"), { recursive: true });
}
