import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatCheck, initProject, originKind, projectChecks, type CheckDeps } from "./project-setup.js";
import type { Http } from "./forge-sink.js";

let dir: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
const repo = (origin?: string) => {
  git("init", "-q");
  if (origin) git("remote", "add", "origin", origin);
};
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pai-setup-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("originKind", () => {
  it("tells forge, github.com (https and ssh) and none apart", () => {
    expect(originKind("https://forge.example/git/ORG/R.git")).toBe("forge");
    expect(originKind("https://github.com/o/r.git")).toBe("github");
    expect(originKind("git@github.com:o/r.git")).toBe("github");
    expect(originKind(undefined)).toBe("none");
  });
});

describe("initProject", () => {
  it("forge origin -> sink forge, anchor/marker only when given", () => {
    repo("https://forge.example/git/ORG/R.git");
    initProject(dir);
    expect(read(".pai/project.yaml")).toBe("status:\n  sink: forge\n");
    expect(read(".pai/worker.md")).not.toMatch(/\d{4}-\d{2}|[0-9a-f]{8}/);
    initProject(dir, { force: true, anchor: 12, marker: "ANCHOR-V1" });
    expect(read(".pai/project.yaml")).toContain("anchor: 12");
    expect(read(".pai/project.yaml")).toContain('marker: "ANCHOR-V1"');
  });

  it("github.com origin and no origin -> sink todo", () => {
    repo("git@github.com:o/r.git");
    initProject(dir);
    expect(read(".pai/project.yaml")).toBe("status:\n  sink: todo\n");
    rmSync(join(dir, ".pai"), { recursive: true });
    git("remote", "remove", "origin");
    initProject(dir);
    expect(read(".pai/project.yaml")).toBe("status:\n  sink: todo\n");
  });

  it("never overwrites without force; force keeps a .bak and existing anchor", () => {
    repo("https://forge.example/git/ORG/R.git");
    mkdirSync(join(dir, ".pai"));
    writeFileSync(join(dir, ".pai/worker.md"), "mine\n");
    writeFileSync(join(dir, ".pai/project.yaml"), 'status:\n  sink: forge\n  forge:\n    anchor: 5\n    marker: "M"\n');
    const r = initProject(dir);
    expect(r.written).toEqual([]);
    expect(r.kept).toEqual([".pai/project.yaml", ".pai/worker.md"]);
    expect(read(".pai/worker.md")).toBe("mine\n");
    initProject(dir, { force: true });
    expect(read(".pai/worker.md.bak")).toBe("mine\n");
    expect(read(".pai/worker.md")).not.toBe("mine\n");
    expect(read(".pai/project.yaml")).toContain("anchor: 5");
  });

  it("dry run writes nothing", () => {
    repo("https://forge.example/git/ORG/R.git");
    const r = initProject(dir, { dryRun: true });
    expect(r.written).toEqual([".pai/project.yaml", ".pai/worker.md"]);
    expect(r.message[0]).toMatch(/^would write/);
    expect(existsSync(join(dir, ".pai"))).toBe(false);
  });
});

describe("projectChecks", () => {
  const base: CheckDeps = {
    host: async () => ({ uid: "U1", term: "w0t0p0:U1", via: "tty" }),
    daemonStart: async () => 2000,
    buildTime: () => 1000,
    env: {},
    platform: "darwin",
  };
  const lines = async (d: CheckDeps = {}) => (await projectChecks(dir, { ...base, ...d })).map(formatCheck);

  it("fresh repo: every missing piece names its one fix command", async () => {
    repo("https://forge.example/git/ORG/R.git");
    const out = await lines({
      host: async () => ({ uid: "", term: "", via: "none", reason: "iTerm2 not running or unreachable" }),
      daemonStart: async () => null,
    });
    expect(out).toEqual([
      "missing - .pai/project.yaml present - fix: pai project init",
      "missing - .pai/worker.md present - fix: pai project init",
      "missing - iTerm host session for worker panes (iTerm2 not running or unreachable) - fix: pai worker pane --check",
      "missing - daemon running - fix: pai daemon restart",
    ]);
  });

  it("after init (todo sink) everything is ok; oversize worker.md is flagged", async () => {
    repo("git@github.com:o/r.git");
    initProject(dir);
    expect((await lines()).every((l) => l.startsWith("ok - "))).toBe(true);
    writeFileSync(join(dir, ".pai/worker.md"), "x".repeat(17 * 1024));
    expect(await lines()).toContain("missing - .pai/worker.md is 17408 bytes, over the 16384 limit - fix: $EDITOR .pai/worker.md");
  });

  it("invalid yaml points at init --force", async () => {
    repo();
    mkdirSync(join(dir, ".pai"));
    writeFileSync(join(dir, ".pai/project.yaml"), "status: [unclosed\n");
    expect((await lines())[0]).toBe("missing - .pai/project.yaml is not valid YAML - fix: pai project init --force");
  });

  describe("forge sink", () => {
    const origin = "https://forge.example/git/ORG/R.git";
    const setup = (forge: string) => {
      repo(origin);
      mkdirSync(join(dir, ".pai"));
      writeFileSync(join(dir, ".pai/project.yaml"), `status:\n  sink: forge\n${forge}`);
    };
    const anchorYaml = '  forge:\n    anchor: 3\n    marker: "MK"\n';
    const http = (anchorBody: string): Http => (_m, url) =>
      url.endsWith("/issues/3") ? { status: 200, text: JSON.stringify({ body: anchorBody }) }
        : url.endsWith("/issues/9") ? { status: 200, text: JSON.stringify({ body: "" }) }
        : { status: 404, text: "" };

    it("anchor and marker unset", async () => {
      setup("");
      expect(await lines({ token: "t", originUrl: origin })).toContain(
        "missing - forge anchor and marker set - fix: pai project init --force --anchor <issue> --marker <text>"
      );
    });

    it("no token", async () => {
      setup(anchorYaml);
      expect(await lines({ token: "", originUrl: origin, http: http("MK handover: #9") })).toContain(
        "missing - forge token present - fix: pai config set forge.token <token>"
      );
    });

    it("marker mismatch and unreachable anchor", async () => {
      setup(anchorYaml);
      const bad = await lines({ token: "t", originUrl: origin, http: http("other") });
      expect(bad.find((l) => l.includes("anchor #3"))).toBe(
        "missing - forge anchor #3: anchor #3 lacks marker - fix: pai project init --force --anchor <issue> --marker <text>"
      );
      const gone = await lines({ token: "t", originUrl: origin, http: () => ({ status: 404, text: "" }) });
      expect(gone.find((l) => l.includes("anchor #3"))).toMatch(/HTTP 404/);
    });

    it("healthy anchor", async () => {
      setup(anchorYaml);
      const out = await lines({ token: "t", originUrl: origin, http: http("MK handover: #9") });
      expect(out).toContain("ok - forge token present; anchor #3 reachable, marker matches");
    });
  });

  describe("daemon", () => {
    it("started before the installed build -> stale, fix is daemon restart", async () => {
      repo();
      expect(await lines({ daemonStart: async () => 500, buildTime: () => 1000 })).toContain(
        "missing - daemon started before the installed build - fix: pai daemon restart"
      );
    });
    it("unknown build time is not stale", async () => {
      repo();
      expect(await lines({ daemonStart: async () => 500, buildTime: () => null })).toContain("ok - daemon running on the installed build");
    });
  });

  it("inside tmux the host check passes without iTerm", async () => {
    repo();
    const out = await lines({ env: { TMUX: "1" }, host: async () => { throw new Error("must not be called"); } });
    expect(out).toContain("ok - worker panes open in tmux");
  });

  it("ignores the process's own terminal ids when no env is passed", async () => {
    repo();
    const prev = { TMUX: process.env.TMUX, ITERM: process.env.ITERM_SESSION_ID };
    process.env.TMUX = "/tmp/tmux-1/default,1,0";
    process.env.ITERM_SESSION_ID = "w0t0p0:AMBIENT";
    let hostCalled = false;
    try {
      const out = (await projectChecks(dir, { ...base, env: undefined, host: async () => { hostCalled = true; return { uid: "U1", term: "w0t0p0:U1", via: "tty" }; } })).map(formatCheck);
      expect(out).not.toContain("ok - worker panes open in tmux");
      expect(hostCalled).toBe(true);
    } finally {
      if (prev.TMUX === undefined) delete process.env.TMUX; else process.env.TMUX = prev.TMUX;
      if (prev.ITERM === undefined) delete process.env.ITERM_SESSION_ID; else process.env.ITERM_SESSION_ID = prev.ITERM;
    }
  });
});
