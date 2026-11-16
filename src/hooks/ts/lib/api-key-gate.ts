/**
 * api-key-gate.ts — the Bash gate chain never lets a command set
 * ANTHROPIC_API_KEY on a process (operator rule: Max plan only; an API key in
 * the env also silently switches claude to API billing and disables claude.ai
 * connectors). Incident 2026-11-16: a worker ran
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:8037 ANTHROPIC_API_KEY=x claude --model apple-fm ...`
 * and nothing stopped it.
 *
 * Denied: `ANTHROPIC_API_KEY=... cmd`, `export/declare/typeset/readonly ANTHROPIC_API_KEY=...`,
 * `env [flags] ANTHROPIC_API_KEY=... cmd` (so `env -S ...` too), `launchctl setenv ANTHROPIC_API_KEY`.
 * Allowed: unset, `env -u ANTHROPIC_API_KEY`, and reading the name (`grep -n ANTHROPIC_API_KEY src/...`,
 * `echo ${ANTHROPIC_API_KEY:+set}`) — text that mentions it is not a setting. Pure: segments come from
 * parseCommand, so quotes group words, operators split segments and heredoc bodies are already dropped.
 */

import { basename } from "node:path";
import { parseCommand } from "./worker-guard.js";
import { dropHeredocBodies } from "./heredoc.js";

const KEY = "ANTHROPIC_API_KEY";
/** Quote-stripped: `'AN'` + `THROPIC...=` concatenates to one word in the shell, so quotes never hide a set. */
const strip = (s: string): string => s.replace(/["']/g, "");
/** An assignment of the key (`NAME=`, any value, empty included). */
const isAssignment = (w: string): boolean => /^ANTHROPIC_API_KEY=/.test(strip(w));

function setsKey(words: string[]): boolean {
  const bin = basename(words[0] ?? "");
  if (bin === "env") {
    // `env -u KEY ...` removes it; a bare `-u` consumes the next word, combined flags (`-iS`, `-b`) stand alone
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (!w.startsWith("-")) break;
      if (/^-[^u]*u$/.test(w)) { i++; continue; }
    }
    return words.some(isAssignment);
  }
  if (bin === "launchctl") return /^launchctl\s+setenv\s+ANTHROPIC_API_KEY\b/.test(strip(words.join(" ")));
  return false;
}

/** `sh -c '<payload>'` / `bash -c …`: the payload runs, so check it like its own command (recursively). */
function shellPayload(words: string[]): string | null {
  const bin = basename(words[0] ?? "");
  if (!/^(?:ba|z|k|c|tc|fi)?sh$/.test(bin) && bin !== "source") return null;
  const c = words.indexOf("-c");
  return c > 0 ? (words[c + 1] ?? null) : null;
}

/** The matched command text when a command sets ANTHROPIC_API_KEY on a process, else null. */
export function apiKeySetMatch(command: string, depth = 0): string | null {
  for (const seg of parseCommand(command)) {
    const joined = seg.words.join(" ");
    if (/^(unset|env\s+-\S*u\s+)\s*ANTHROPIC_API_KEY\b/.test(strip(joined))) continue;
    if (/^(export|declare|typeset|readonly)\s+(-\S+\s+)*ANTHROPIC_API_KEY=/.test(strip(joined))) return joined;
    if (setsKey(seg.words)) return joined;
    // leading assignments before the command word: `FOO=1 ANTHROPIC_API_KEY=x cmd`
    for (const w of seg.words) {
      if (!/^[A-Za-z_]\w*=/.test(strip(w))) break;
      if (isAssignment(w)) return joined;
    }
    const payload = shellPayload(seg.words);
    if (payload && depth < 3) {
      const inner = apiKeySetMatch(dropHeredocBodies(payload), depth + 1);
      if (inner) return `${joined} [${inner}]`;
    }
  }
  return null;
}

export const API_KEY_SET_REASON =
  `Never set ${KEY} on a process (operator rule: Max plan only). To reach a local/OpenAI-compatible endpoint use the provider route: ` +
  "`pai worker run --local <model>` / the per-run settings file PAI writes. Reading it (grep, env -u, unset) is fine.";
