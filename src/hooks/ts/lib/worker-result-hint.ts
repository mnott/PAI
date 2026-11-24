/**
 * worker-result-hint.ts — tell a local worker what an empty or no-match result means.
 *
 * Three signal-2 workers stopped on 2026-11-24 by the loop guard on identical
 * repeats: `npx tsc --noEmit` returning "(Bash completed with no output)" was
 * re-run 5 times (empty output is success, the model did not know); a grep for
 * names it guessed returned other matches and was repeated 8 times; a
 * `git config --list | grep` was repeated 7 times. A local model reads an
 * empty, unexpected or denied result as "try again" instead of "this is the
 * answer". These pure functions turn those results into one explicit sentence
 * the PostToolUse hook injects as additionalContext.
 *
 * Worker-only and local-provider-only: an interactive session or a cloud
 * worker already reads empty output as success and does not need the hint.
 */

import { isLoopbackUrl } from "../../../utils/loopback.js";
import { ANTHROPIC_NATIVE, readWorkersCached, type WorkersConfig } from "../../../workers/config.js";

/**
 * The literal the harness sends when a command produced no output (observed in
 * worker transcripts 2026-11-24: `"(Bash completed with no output)"`). A model
 * reads it as an unknown result and re-runs the command; the hook treats it as
 * empty output and names the success.
 */
export const NO_OUTPUT_SENTINEL = "(Bash completed with no output)";

/** The success sentence for an empty command result. */
export const EMPTY_SUCCESS_HINT =
  "exit 0, no output: the command succeeded (for tsc/vitest/lint: no errors). Do not run it again unless you changed a file.";

/** The search sentence when a grep-like command returned output that contains none of the searched names. */
export const SEARCH_MISS_HINT =
  "none of the searched names appear: the name is probably different; search a shorter part of the name or use `pai code search <words>`.";

/** Commands that search for names in text. */
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);

/**
 * The Bash tool result as Claude Code sends it: an object
 * `{ stdout, stderr, interrupted, isImage }`, not a string. The old hook read
 * `tool_response` as a string and JSON.stringify'd the object, so a run with
 * empty stdout+stderr looked non-empty and the hint never fired (A/B run
 * 20261124-070310-23895: zero hints). `interrupted: true` means the operator
 * stopped the command — that is not a success, so it is never treated as
 * empty. The string shape (older harnesses, the "(Bash completed with no
 * output)" sentinel) is still accepted.
 */
export function toolResultText(response: unknown): string {
  if (typeof response === "string") return response;
  if (response && typeof response === "object") {
    const r = response as { stdout?: unknown; stderr?: unknown; interrupted?: unknown };
    if (r.interrupted === true) {
      const parts = [typeof r.stdout === "string" ? r.stdout : "", typeof r.stderr === "string" ? r.stderr : ""];
      return parts.filter(Boolean).join("\n") || "(interrupted)";
    }
    const parts = [typeof r.stdout === "string" ? r.stdout : "", typeof r.stderr === "string" ? r.stderr : ""];
    return parts.filter(Boolean).join("\n");
  }
  return "";
}

/**
 * True when this worker run is on a local (loopback) model provider.
 * `PAI_WORKER_PROVIDER` is the provider name the runner set; a provider whose
 * baseUrl is loopback is local. A missing name or an unknown provider is not
 * treated as local — the hint is only ever added when local is proven.
 */
export function isLocalWorkerProvider(
  env: NodeJS.ProcessEnv = process.env,
  cfg: WorkersConfig | null = null
): boolean {
  const name = env.PAI_WORKER_PROVIDER;
  if (!name || name === ANTHROPIC_NATIVE) return false;
  try {
    const providers = (cfg ?? readWorkersCached()).providers;
    const p = providers?.[name];
    return p !== undefined && isLoopbackUrl(p.baseUrl);
  } catch {
    return false;
  }
}

/** The literal strings a search command looks for: its pattern argument only, minus flags and shell quotes. */
function searchPatterns(words: string[]): string[] {
  for (const w of words) {
    if (w.startsWith("-")) continue;
    return stripQuotes(w);
  }
  return [];
}

/**
 * Drop the surrounding shell quotes a pattern argument carries, then split a
 * grep alternation (`foo\|bar`) into its branches: each branch is a name the
 * search looked for, and none of them appearing is the miss signal.
 */
function stripQuotes(w: string): string[] {
  return w
    .replace(/^['"]|['"]$/g, "")
    .split("\\|")
    .map((b) => b.trim())
    .filter(Boolean);
}

/** Split a command into shell segments on `;`, `&&`, `||` and newlines. */
function segments(command: string): string[][] {
  return command
    .split(/[;\n]|&&|\|\|/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((w) => w.length > 0);
}

/**
 * The hint for a Bash result, or null when nothing to say.
 *
 * - empty output → the success sentence (the model must not re-run it);
 * - a grep-like segment whose output contains none of its searched names →
 *   the search sentence (the name it guessed does not exist).
 *
 * `output` is the tool result text as the model sees it.
 */
export function bashResultHint(command: string, output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed || trimmed === NO_OUTPUT_SENTINEL) return EMPTY_SUCCESS_HINT;
  for (const seg of segments(command)) {
    const cmd = seg[0];
    if (!SEARCH_COMMANDS.has(cmd)) continue;
    const patterns = searchPatterns(seg.slice(1));
    if (patterns.length === 0) continue;
    // a multi-word pattern (a phrase, or a regex with metacharacters) cannot be
    // judged by a substring check: a miss would be a false alarm, so stay silent.
    if (patterns.some((p) => /\s/.test(p) || /[.*?+()[\]{}]/.test(p))) continue;
    if (patterns.some((p) => output.includes(p))) continue;
    return SEARCH_MISS_HINT;
  }
  return null;
}
