import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_VERIFY, depsNeedInstall, resolveVerify, runRelatedTests } from "./merge-tests.js";

const dirs: string[] = [];
function repo(files: Record<string, string>, mkdirs: string[] = []): string {
  const d = mkdtempSync(join(tmpdir(), "pai-verify-"));
  dirs.push(d);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
  for (const m of mkdirs) mkdirSync(join(d, m));
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CFG = "custom-default-not-set";

describe("resolveVerify pubspec", () => {
  it("flutter pubspec with test/ -> flutter test", () => {
    const d = repo({ "pubspec.yaml": "name: a\ndependencies:\n  flutter:\n    sdk: flutter\n" }, ["test"]);
    expect(resolveVerify(d, DEFAULT_VERIFY).cmd).toBe("flutter test");
  });
  it("dart pubspec with test/ -> dart test", () => {
    const d = repo({ "pubspec.yaml": "name: a\ndependencies:\n  path: ^1.0.0\n" }, ["test"]);
    expect(resolveVerify(d, DEFAULT_VERIFY).cmd).toBe("dart test");
  });
  it("pubspec without test/ -> nothing to run", () => {
    const d = repo({ "pubspec.yaml": "name: a\ndependencies:\n  flutter:\n    sdk: flutter\n" });
    expect(resolveVerify(d, DEFAULT_VERIFY).cmd).toBe("");
  });
  it("existing runners unchanged", () => {
    expect(resolveVerify(repo({ "go.mod": "module a\n" }), DEFAULT_VERIFY).cmd).toBe("go test ./...");
    expect(resolveVerify(repo({ "pytest.ini": "" }), DEFAULT_VERIFY).cmd).toBe("python3 -m pytest -q");
    expect(resolveVerify(repo({}), DEFAULT_VERIFY).cmd).toBe("");
    expect(resolveVerify(repo({}), CFG).cmd).toBe(CFG);
  });
});

describe("runRelatedTests deps install", () => {
  const ok = { code: 0, signal: null, timedOut: false, error: null, output: "" };
  const git = () => "a.ts\0";
  const settings = { verify: DEFAULT_VERIFY, verifyTimeoutSec: 5 };
  const files = { "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "package-lock.json": "{}" };

  it("installs with npm ci before the verify command and reports it", () => {
    const d = repo(files);
    const calls: string[] = [];
    const r = runRelatedTests(d, "x", settings, git, undefined, (_c, _e, cmds) => (calls.push(cmds[0]), ok));
    expect(calls).toEqual(["npm ci", "npm test"]);
    expect(r.status).toBe("passed");
    expect(r.line).toMatch(/^deps installed \(\d+s\); passed/);
  });
  it("npm install without a lockfile; no install when node_modules is current", () => {
    const d = repo({ "package.json": files["package.json"] });
    const calls: string[] = [];
    runRelatedTests(d, "x", settings, git, undefined, (_c, _e, cmds) => (calls.push(cmds[0]), ok));
    expect(calls[0]).toBe("npm install");
    const e = repo(files, ["node_modules"]);
    expect(depsNeedInstall(e)).toBe(true); // lockfile present, no node_modules/.package-lock.json marker
  });
  it("install failure is setup, not failed tests", () => {
    const d = repo(files);
    const calls: string[] = [];
    const r = runRelatedTests(d, "x", settings, git, undefined, (_c, _e, cmds) => (calls.push(cmds[0]), { ...ok, code: 1, output: "ENOTFOUND" }));
    expect(calls).toEqual(["npm ci"]);
    expect(r.status).toBe("setup");
    expect(r.line).toMatch(/^deps install failed/);
  });
});
