import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseStatusConfig, deriveRepo, extractHandoverNumber, upsertSection,
  writeContinueToForge, ForgeError, SECTION_OPEN, SECTION_CLOSE, type Http,
} from "./forge-sink.js";
import { applyContinue } from "./checkpoint-block.js";

const CFG = { sink: "forge" as const, anchor: 283, marker: "ANCHOR-V1", repo: undefined };
const ORIGIN = "https://forge.example/git/ORG/Proj.git";
const ISSUES: Record<number, string> = { 283: "x ANCHOR-V1\nhandover: #300\n", 300: "intro\n\ntail\n" };

function fakeHttp(issues: Record<number, string>, log: string[] = [], patchStatus = 200): Http {
  return (method, url, token, body) => {
    expect(token).toBe("tok");
    const n = Number(url.split("/").pop());
    log.push(`${method} ${url}`);
    if (method === "PATCH") {
      issues[n] = JSON.parse(body!).body;
      return { status: patchStatus, text: "{}" };
    }
    return n in issues ? { status: 200, text: JSON.stringify({ body: issues[n] }) } : { status: 404, text: "" };
  };
}

describe("config", () => {
  it("defaults to todo", () => {
    expect(parseStatusConfig("").sink).toBe("todo");
    expect(parseStatusConfig("status:\n  sink: bogus\n").sink).toBe("todo");
  });
  it("parses forge keys", () => {
    expect(parseStatusConfig("status:\n  sink: forge\n  forge:\n    anchor: 283\n    marker: M\n    repo: A/B\n"))
      .toEqual({ sink: "forge", anchor: 283, marker: "M", repo: "A/B" });
  });
});

describe("deriveRepo", () => {
  it("handles prefixed forge URLs", () => {
    expect(deriveRepo("https://host/git/APPS/Repo.git\n")).toEqual({ apiBase: "https://host/git/api/v1", repo: "APPS/Repo" });
  });
  it("handles unprefixed and credentialed URLs", () => {
    expect(deriveRepo("https://u:p@host/O/R")).toEqual({ apiBase: "https://host/api/v1", repo: "O/R" });
  });
  it("rejects non-http origins", () => {
    expect(() => deriveRepo("git@host:O/R.git")).toThrow(ForgeError);
  });
});

describe("anchor", () => {
  it("prefers the handover line", () => {
    expect(extractHandoverNumber("see #5\nM\nhandover: #300", "M")).toBe(300);
  });
  it("falls back to first #n after the marker", () => {
    expect(extractHandoverNumber("#5 before\nM then #77 and #78", "M")).toBe(77);
    expect(extractHandoverNumber("M nothing", "M")).toBeUndefined();
  });
});

describe("upsertSection", () => {
  it("appends and keeps the body byte-identical", () => {
    const body = "intro\r\n\n  tail  \n";
    const out = upsertSection(body, "NEW");
    expect(out.startsWith(body)).toBe(true);
    expect(out).toContain(`${SECTION_OPEN}\nNEW\n${SECTION_CLOSE}`);
  });
  it("replaces in place, rest untouched", () => {
    const pre = "head\n\n", post = "\n\nfoot  \n";
    const once = `${pre}${SECTION_OPEN}\nONE\n${SECTION_CLOSE}${post}`;
    const twice = upsertSection(once, "TWO");
    expect(twice).toBe(once.replace("ONE", "TWO"));
    expect(twice.startsWith("head")).toBe(true);
    expect(twice.endsWith(post)).toBe(true);
  });
});

describe("writeContinueToForge", () => {
  it("GET anchor, GET handover, PATCH body", () => {
    const issues = { ...ISSUES }, log: string[] = [];
    const r = writeContinueToForge(".", CFG, "MD", { http: fakeHttp(issues, log), token: "tok", originUrl: ORIGIN });
    expect(r.issue).toBe(300);
    expect(log.map(l => l.split(" ")[0])).toEqual(["GET", "GET", "PATCH"]);
    expect(log[0]).toBe("GET https://forge.example/git/api/v1/repos/ORG/Proj/issues/283");
    expect(issues[300]).toBe(upsertSection(ISSUES[300], "MD"));
  });
  it("dry run never patches", () => {
    const log: string[] = [];
    writeContinueToForge(".", CFG, "MD", { http: fakeHttp({ ...ISSUES }, log), token: "tok", originUrl: ORIGIN, dryRun: true });
    expect(log).toHaveLength(2);
  });
  it.each([
    ["marker mismatch", { 283: "no marker", 300: "" }, /lacks marker/],
    ["no handover number", { 283: "ANCHOR-V1 only" }, /no handover number/],
    ["http error", {}, /HTTP 404/],
  ])("fails on %s", (_n, issues, re) => {
    expect(() => writeContinueToForge(".", CFG, "MD", { http: fakeHttp(issues as Record<number, string>), token: "tok", originUrl: ORIGIN })).toThrow(re);
  });
  it("fails without token", () => {
    vi.stubEnv("FORGE_TOKEN", ""); vi.stubEnv("AIBROKER_FORGE_TOKEN", "");
    vi.stubEnv("PAI_CONFIG_FILE", join(tmpdir(), "pai-no-such-config.json"));
    expect(() => writeContinueToForge(".", CFG, "MD", { http: fakeHttp({}), originUrl: ORIGIN })).toThrow(/no forge token/);
    vi.unstubAllEnvs();
  });
});

describe("applyContinue sink", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pai-forge-sink-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "Notes"));
    mkdirSync(join(root, ".pai"));
    writeFileSync(join(root, ".pai", "project.yaml"), "status:\n  sink: forge\n  forge:\n    anchor: 283\n    marker: M\n");
    writeFileSync(join(root, "Notes", "TODO.md"), "# TODO\n");
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("falls back to TODO.md with one loud line", () => {
    vi.stubEnv("FORGE_TOKEN", ""); vi.stubEnv("AIBROKER_FORGE_TOKEN", "");
    vi.stubEnv("PAI_CONFIG_FILE", join(root, "none.json"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = applyContinue({ rootPath: root, authored: "model", sessionLine: "s", cwd: root, body: "real body text here" });
    expect(r.action).toBe("written");
    expect(readFileSync(join(root, "Notes", "TODO.md"), "utf8")).toContain("real body text here");
    expect(err).toHaveBeenCalledWith("handover: forge write failed (no forge token) - wrote Notes/TODO.md instead");
  });

  it("todo sink (no project.yaml) is unchanged", () => {
    rmSync(join(root, ".pai"), { recursive: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    applyContinue({ rootPath: root, authored: "model", sessionLine: "s", cwd: root, body: "b" });
    expect(err).not.toHaveBeenCalled();
    expect(existsSync(join(root, "Notes", "TODO.md"))).toBe(true);
  });
});

describe("scope", () => {
  it("the sink switch lives only in the Continue writer, never in session-note code", () => {
    const hits = execFileSync("grep", ["-rl", "forge-sink", "src", "--include=*.ts"], { encoding: "utf8" })
      .split("\n").filter(Boolean).filter(f => !f.endsWith("forge-sink.test.ts") && !f.endsWith("forge-sink.ts"));
    expect(hits).toEqual(["src/session/checkpoint-block.ts"]);
  });
});
