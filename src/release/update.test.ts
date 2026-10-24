import { describe, expect, it } from "vitest";
import { bumpVersion, compareVersions, githubRepoOf, latestInstallUrl, parseGithubRepo, stableAssetName } from "./repo-facts.js";
import { formatUpdate, pickAsset, updatePackage, UpdateFailed, type HttpGet } from "./update.js";
import type { RunFn } from "./release.js";

const pkg = { name: "@acme/tool", version: "1.0.9", repository: { url: "git+https://github.com/acme/tool.git" } };
const release = (tag: string, names = ["tool.tgz", "acme-tool-X.tgz"]): HttpGet => async (url) => {
  expect(url).toBe("https://api.github.com/repos/acme/tool/releases/latest");
  return { status: 200, text: JSON.stringify({ tag_name: tag, assets: names.map((n) => ({ name: n, browser_download_url: `https://github.com/acme/tool/releases/download/${tag}/${n}` })) }) };
};

describe("versions", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("v2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(() => compareVersions("x", "1.0.0")).toThrow();
  });
  it("bumps", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    expect(bumpVersion("1.2.3", "3.0.0")).toBe("3.0.0");
    expect(() => bumpVersion("1.2.3", "huge")).toThrow();
  });
  it("reads GitHub owner/repo and builds the stable URL", () => {
    expect(parseGithubRepo("git@github.com:o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(parseGithubRepo("github:o/r")).toEqual({ owner: "o", repo: "r" });
    expect(parseGithubRepo("https://git.example/APPS/r.git")).toBeNull();
    expect(githubRepoOf(pkg)).toEqual({ owner: "acme", repo: "tool" });
    expect(stableAssetName("@acme/tool")).toBe("tool.tgz");
    expect(latestInstallUrl({ owner: "acme", repo: "tool" }, "@acme/tool")).toBe("https://github.com/acme/tool/releases/latest/download/tool.tgz");
  });
});

describe("updatePackage", () => {
  const calls: string[] = [];
  const run: RunFn = async (c, a) => (calls.push([c, ...a].join(" ")), { code: 0, stdout: "", stderr: "" });
  const installed = async (): Promise<typeof pkg> => pkg;

  it("--check reports a newer release and installs nothing", async () => {
    calls.length = 0;
    const r = await updatePackage({ check: true }, { http: release("v1.0.10"), run, installed });
    expect(r).toMatchObject({ newer: true, updated: false, latest: "1.0.10", installed: "1.0.9" });
    expect(r.assetUrl).toBe("https://github.com/acme/tool/releases/download/v1.0.10/tool.tgz");
    expect(calls).toEqual([]);
    expect(formatUpdate(r)).toContain("update available");
  });

  it("installs the asset url when newer", async () => {
    calls.length = 0;
    const r = await updatePackage({}, { http: release("v1.1.0"), run, installed });
    expect(r.updated).toBe(true);
    expect(calls).toEqual(["npm i -g https://github.com/acme/tool/releases/download/v1.1.0/tool.tgz"]);
  });

  it("does nothing when current or ahead", async () => {
    calls.length = 0;
    expect((await updatePackage({}, { http: release("v1.0.9"), run, installed })).newer).toBe(false);
    expect((await updatePackage({}, { http: release("v1.0.8"), run, installed })).newer).toBe(false);
    expect(calls).toEqual([]);
  });

  it("falls back to the first tgz and fails clearly without release, asset or install", async () => {
    expect(pickAsset([{ name: "a.tgz", browser_download_url: "u" }], "@acme/tool")).toBe("u");
    await expect(updatePackage({}, { http: async () => ({ status: 404, text: "" }), run, installed })).rejects.toThrow(UpdateFailed);
    await expect(updatePackage({}, { http: release("v2.0.0", []), run, installed })).rejects.toThrow("no .tgz asset");
    await expect(updatePackage({ package: "nope" }, { http: release("v2.0.0"), run, installed: async () => null })).rejects.toThrow("not installed");
  });
});
