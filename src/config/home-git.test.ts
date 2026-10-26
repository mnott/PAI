import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitHomeChange, gitignoreWithRequired } from "./home-git.js";
import { homeGitSetupCmd } from "../cli/impl/home.js";
import { writeDualFormatConfigRaw } from "./main-config.js";

let home: string;
let saved: string | undefined;
const git = (...a: string[]) => execFileSync("git", ["-C", home, ...a], { encoding: "utf8" });
const count = () => Number(git("rev-list", "--count", "HEAD").trim());

beforeEach(() => {
  saved = process.env.PAI_HOME;
  home = mkdtempSync(join(tmpdir(), "pai-home-git-"));
  process.env.PAI_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

function initRepo(): void {
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(home, ".gitignore"), "# mine\n/*\n!/.gitignore\n!/config.yaml\n");
  git("add", "-f", ".gitignore");
  git("commit", "-q", "-m", "init");
}

describe("commitHomeChange", () => {
  it("commits only the given paths, forcing past .gitignore", () => {
    initRepo();
    mkdirSync(join(home, "antipatterns"));
    writeFileSync(join(home, "antipatterns", "x.yaml"), "a: 1\n");
    writeFileSync(join(home, "antipatterns", "governance.jsonl"), "{}\n");
    writeFileSync(join(home, "other.txt"), "x");
    commitHomeChange(["antipatterns/x.yaml", join(home, "antipatterns", "governance.jsonl")], "set x");
    expect(count()).toBe(2);
    expect(git("log", "-1", "--format=%s").trim()).toBe("config: set x");
    expect(git("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["antipatterns/governance.jsonl", "antipatterns/x.yaml"]);
  });

  it("never commits firings, databases or logs", () => {
    initRepo();
    mkdirSync(join(home, "antipatterns"));
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "antipatterns", "firings.jsonl"), "{}\n");
    writeFileSync(join(home, "antipatterns", "firings.jsonl.1"), "{}\n");
    writeFileSync(join(home, "memory.db"), "x");
    writeFileSync(join(home, "logs", "a.log"), "x");
    commitHomeChange(["antipatterns/firings.jsonl", "antipatterns/firings.jsonl.1", "memory.db", "logs/a.log"], "x");
    expect(count()).toBe(1);
    expect(git("ls-files").trim()).toBe(".gitignore");
  });

  it("is a no-op without .git, and does not throw", () => {
    writeFileSync(join(home, "config.yaml"), "a: 1\n");
    expect(() => commitHomeChange(["config.yaml"], "x")).not.toThrow();
    expect(existsSync(join(home, ".git"))).toBe(false);
  });

  it("makes no commit when nothing changed", () => {
    initRepo();
    commitHomeChange([".gitignore"], "x");
    expect(count()).toBe(1);
  });

  it("honours home.autoCommit: false", () => {
    initRepo();
    writeFileSync(join(home, "config.yaml"), "home:\n  autoCommit: false\n");
    commitHomeChange(["config.yaml"], "x");
    expect(count()).toBe(1);
  });

  it("is driven by the config writer", () => {
    initRepo();
    writeFileSync(join(home, "config.yaml"), "a: 1\n");
    git("add", "config.yaml");
    git("commit", "-q", "-m", "cfg");
    writeDualFormatConfigRaw(join(home, "config.json"), { a: 2 });
    expect(count()).toBe(3);
    expect(git("log", "-1", "--format=%s").trim()).toBe("config: update config.yaml");
  });
});

describe("git-setup", () => {
  it("appends only missing lines, keeps comments, is idempotent", () => {
    const before = "# mine\n/*\n!/antipatterns/\n!/config.yaml";
    const once = gitignoreWithRequired(before);
    expect(once).toBe("# mine\n/*\n!/antipatterns/\n!/config.yaml\n/antipatterns/firings.jsonl*\n/antipatterns/outcomes.jsonl*\n");
    expect(gitignoreWithRequired(once)).toBe(once);
  });

  it("dry run changes nothing; --write commits once; second run is a no-op", () => {
    initRepo();
    expect(homeGitSetupCmd({}, home)).toBe(0);
    expect(readFileSync(join(home, ".gitignore"), "utf8")).not.toContain("antipatterns");
    expect(count()).toBe(1);
    homeGitSetupCmd({ write: true }, home);
    const text = readFileSync(join(home, ".gitignore"), "utf8");
    expect(text.startsWith("# mine\n/*\n")).toBe(true);
    expect(text).toContain("!/antipatterns/\n/antipatterns/firings.jsonl*\n/antipatterns/outcomes.jsonl*\n");
    expect(count()).toBe(2);
    homeGitSetupCmd({ write: true }, home);
    expect(count()).toBe(2);
  });
});
