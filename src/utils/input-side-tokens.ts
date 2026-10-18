/**
 * Leaf module (no imports): hook bundles use it, so it must never reach the
 * storage / embedding stack that workers/run.ts pulls in.
 */

export interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Input-side tokens of one usage block: input + cache read + cache creation (no output). */
export function inputSideTokens(u: UsageBlock): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
