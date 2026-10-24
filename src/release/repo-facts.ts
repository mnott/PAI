/**
 * Facts a release or an update needs, read from package.json and git remotes:
 * package name, version, GitHub owner/repo, stable asset name. Nothing is hard-coded.
 */

export interface GithubRepo {
  owner: string;
  repo: string;
}

/** "git+https://github.com/o/r.git", "git@github.com:o/r.git", "github:o/r", "https://github.com/o/r" -> {o, r}; null when not GitHub. */
export function parseGithubRepo(url: string | undefined): GithubRepo | null {
  if (!url) return null;
  const u = url.trim();
  const m =
    u.match(/^github:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/) ??
    u.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?(?:#.*)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** package.json `repository` (string or {url}) -> GitHub owner/repo. */
export function githubRepoOf(pkg: { repository?: unknown }): GithubRepo | null {
  const r = pkg.repository;
  if (typeof r === "string") return parseGithubRepo(r);
  if (r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string") return parseGithubRepo((r as { url: string }).url);
  return null;
}

/** "@scope/pai" -> "pai": the unscoped package name. */
export const baseName = (pkgName: string): string => pkgName.replace(/^@[^/]+\//, "");

/** Stable release asset name, no version: "@scope/pai" -> "pai.tgz". */
export const stableAssetName = (pkgName: string): string => `${baseName(pkgName)}.tgz`;

/** The versioned file `npm pack` writes: "@scope/pai" 1.2.3 -> "scope-pai-1.2.3.tgz". */
export const versionedAssetName = (pkgName: string, version: string): string => `${pkgName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

/** The install URL that always serves the newest release. */
export const latestInstallUrl = (g: GithubRepo, pkgName: string): string =>
  `https://github.com/${g.owner}/${g.repo}/releases/latest/download/${stableAssetName(pkgName)}`;

/** Parse "1.2.3" or "v1.2.3" (pre-release suffix ignored for ordering of the core triple); null when not semver. */
export function parseVersion(v: string): [number, number, number, string] | null {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : null;
}

/** <0, 0, >0 like a comparator; a pre-release sorts below its release. Throws on a non-semver input. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  if (pa[3] === pb[3]) return 0;
  if (!pa[3]) return 1;
  if (!pb[3]) return -1;
  return pa[3] < pb[3] ? -1 : 1;
}

/** Next version for patch|minor|major, or an explicit x.y.z. */
export function bumpVersion(current: string, bump: string): string {
  if (parseVersion(bump) && !/^(patch|minor|major)$/.test(bump)) return bump.replace(/^v/, "");
  const p = parseVersion(current);
  if (!p) throw new Error(`current version is not semver: ${current}`);
  if (bump === "major") return `${p[0] + 1}.0.0`;
  if (bump === "minor") return `${p[0]}.${p[1] + 1}.0`;
  if (bump === "patch") return `${p[0]}.${p[1]}.${p[2] + 1}`;
  throw new Error(`--bump must be patch, minor, major or x.y.z (got "${bump}")`);
}
