/** Delete ANTHROPIC_API_KEY from `env` (in place) and return it: no process PAI
 *  spawns may carry a key that makes Claude Code bill the API instead of the
 *  Max plan. ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL (local providers) are
 *  left alone. Leaf module (no imports) so any spawner can use it without
 *  creating an import cycle. */
export function stripApiKey<T extends NodeJS.ProcessEnv>(env: T): T {
  delete env.ANTHROPIC_API_KEY;
  return env;
}
