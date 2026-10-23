/**
 * npm publish credential check: `npm whoami` against the public registry.
 * The granular token in ~/.npmrc expires silently; this says so before `npm publish` fails with a 404.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WhoamiResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type WhoamiRunner = () => WhoamiResult;

export type NpmAuth =
  | { state: "ok"; user: string }
  | { state: "rejected"; detail: string; message: string }
  | { state: "unknown"; detail: string };

const REGISTRY = "https://registry.npmjs.org/";

export const realWhoami: WhoamiRunner = () => {
  const r = spawnSync("npm", ["whoami", "--registry", REGISTRY], { encoding: "utf8", timeout: 10_000 });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut };
};

/** The package is publishable: has a package.json that is not private. */
export function publishablePackage(cwd: string): { name: string } | null {
  const p = join(cwd, "package.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { name?: string; private?: boolean };
    return j.private || !j.name ? null : { name: j.name };
  } catch {
    return null;
  }
}

/** Tokens page: the scope of a scoped package name, else the generic `~` page. */
export function tokensUrl(pkgName: string | undefined): string {
  const scope = pkgName?.startsWith("@") ? pkgName.slice(1).split("/")[0] : "";
  return `https://www.npmjs.com/settings/${scope || "~"}/tokens`;
}

export function renewalMessage(status: string, pkgName: string | undefined): string {
  return (
    `npm publish credential rejected (whoami: ${status}). Renew the granular token: ${tokensUrl(pkgName)} → Generate New Token → ` +
    "Bypass 2FA, Read and write, All packages, 90 days, date-named → replace the _authToken line in ~/.npmrc."
  );
}

export function checkNpmAuth(pkgName: string | undefined, run: WhoamiRunner = realWhoami): NpmAuth {
  const r = run();
  if (r.timedOut) return { state: "unknown", detail: "timeout" };
  if (r.status === 0) return { state: "ok", user: r.stdout.trim() };
  const code = /\b(E?[1-5]\d\d)\b/.exec(r.stderr)?.[1]?.replace(/^E/, "");
  // no npm, offline or a registry hiccup is not a credential verdict
  if (!code || !/^(401|403|404)$/.test(code)) return { state: "unknown", detail: code ?? `exit ${r.status}` };
  return { state: "rejected", detail: code, message: renewalMessage(code, pkgName) };
}
