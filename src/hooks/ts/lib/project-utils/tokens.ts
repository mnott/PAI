/**
 * Session token counting from .jsonl transcript files.
 */

import { existsSync, readFileSync } from 'fs';

/**
 * Calculate total tokens from a session .jsonl file.
 * Sums input, output, cache_creation, and cache_read tokens.
 */
export function calculateSessionTokens(jsonlPath: string): number {
  if (!existsSync(jsonlPath)) return 0;

  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');
    let totalTokens = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.message?.usage) {
          const usage = entry.message.usage;
          totalTokens += (usage.input_tokens || 0);
          totalTokens += (usage.output_tokens || 0);
          totalTokens += (usage.cache_creation_input_tokens || 0);
          totalTokens += (usage.cache_read_input_tokens || 0);
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return totalTokens;
  } catch (error) {
    console.error(`Error calculating tokens: ${error}`);
    return 0;
  }
}
