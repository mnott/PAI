/** True on a CI runner (GitHub Actions sets both). Release gates that need the operator's machine skip there. */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true";
}
