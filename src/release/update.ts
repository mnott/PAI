/**
 * `pai update`: install the newest GitHub Release of a package. Reads the
 * installed version, asks the GitHub API for the latest release of the
 * package's repository (package.json `repository`), and when it is newer runs
 * `npm i -g <asset url>`. `--check` only reports.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseName, compareVersions, githubRepoOf, stableAssetName, type GithubRepo } from "./repo-facts.js";
import { packageRoot } from "../module-paths.js";
import { realRun, type RunFn } from "./release.js";

export interface HttpResponse {
  status: number;
  text: string;
}
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export interface InstalledPackage {
  name: string;
  version: string;
  repo: GithubRepo;
}

export interface UpdateDeps {
  http?: HttpGet;
  run?: RunFn;
  /** Reads the installed package.json for a name; null when not installed. */
  installed?: (name: string | undefined) => Promise<{ name?: string; version?: string; repository?: unknown } | null>;
}

export interface UpdateReport {
  package: string;
  installed: string;
  latest: string;
  newer: boolean;
  assetUrl: string;
  repo: string;
  updated: boolean;
}

export class UpdateFailed extends Error {}

const realHttp: HttpGet = async (url, headers) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  return { status: r.status, text: await r.text() };
};

/** This package's own package.json, or the globally installed one named `name`. */
async function defaultInstalled(name: string | undefined, run: RunFn): Promise<{ name?: string; version?: string; repository?: unknown } | null> {
  const own = JSON.parse(readFileSync(join(packageRoot(import.meta.url), "package.json"), "utf8")) as { name?: string; version?: string; repository?: unknown };
  if (!name || name === own.name || name === baseName(own.name ?? "")) return own;
  const root = await run("npm", ["root", "-g"], { cwd: process.cwd() });
  if (root.code !== 0) return null;
  const f = join(root.stdout.trim(), name, "package.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { name?: string; version?: string; repository?: unknown }) : null;
}

/** Pick the release asset: the stable `<name>.tgz`, else the first .tgz. */
export function pickAsset(assets: { name: string; browser_download_url: string }[], pkgName: string): string | null {
  const tgz = assets.filter((a) => a.name.endsWith(".tgz"));
  return (tgz.find((a) => a.name === stableAssetName(pkgName)) ?? tgz[0])?.browser_download_url ?? null;
}

/** Compare the installed version to the latest GitHub release; install it when newer and `check` is false. */
export async function updatePackage(opts: { package?: string; check?: boolean }, deps: UpdateDeps = {}): Promise<UpdateReport> {
  const run = deps.run ?? realRun;
  const http = deps.http ?? realHttp;
  const pkg = await (deps.installed ?? ((n) => defaultInstalled(n, run)))(opts.package);
  if (!pkg || !pkg.name || !pkg.version) throw new UpdateFailed(`${opts.package ?? "pai"} is not installed (npm i -g <release url>)`);
  const repo = githubRepoOf(pkg);
  if (!repo) throw new UpdateFailed(`${pkg.name}: package.json has no GitHub repository`);
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "pai-update" };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await http(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, headers);
  if (r.status === 404) throw new UpdateFailed(`${repo.owner}/${repo.repo} has no published release yet`);
  if (r.status < 200 || r.status >= 300) throw new UpdateFailed(`GitHub API answered HTTP ${r.status} for ${repo.owner}/${repo.repo}`);
  let rel: { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
  try {
    rel = JSON.parse(r.text);
  } catch {
    throw new UpdateFailed("GitHub API answered with something that is not JSON");
  }
  if (!rel.tag_name) throw new UpdateFailed("latest release has no tag");
  const latest = rel.tag_name.replace(/^v/, "");
  const assetUrl = pickAsset(rel.assets ?? [], pkg.name);
  if (!assetUrl) throw new UpdateFailed(`release ${rel.tag_name} has no .tgz asset`);
  const newer = compareVersions(latest, pkg.version) > 0;
  const report: UpdateReport = { package: pkg.name, installed: pkg.version, latest, newer, assetUrl, repo: `${repo.owner}/${repo.repo}`, updated: false };
  if (newer && !opts.check) {
    const i = await run("npm", ["i", "-g", assetUrl], { cwd: process.cwd() });
    if (i.code !== 0) throw new UpdateFailed(`npm i -g failed (exit ${i.code}): ${(i.stderr || i.stdout).trim().split("\n").slice(-3).join(" | ")}`);
    report.updated = true;
  }
  return report;
}

/** One line: "pai 1.0.24 -> 1.0.25 (installed)" / "up to date" / "update available". */
export function formatUpdate(r: UpdateReport): string {
  if (!r.newer) return `${r.package} ${r.installed}: up to date (latest ${r.latest})`;
  if (r.updated) return `${r.package} ${r.installed} -> ${r.latest}: installed from ${r.assetUrl}; run \`pai reload\``;
  return `${r.package} ${r.installed} -> ${r.latest}: update available (run \`pai update${r.package.endsWith("/pai") ? "" : ` --package ${baseName(r.package)}`}\`)`;
}
