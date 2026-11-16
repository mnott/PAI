/**
 * delegation-gate.ts — PAI's own delegation rules for the Bash tool (pure; the hook entry
 * pre-tool-use/delegation-guard.ts does the I/O). They used to live in a hook outside any repo.
 *
 *  (c) every session: no recursive search rooted at / or the home folder.
 *  (b) outside a worker (PAI_WORKER != 1): a worker runs behind a visible pane; --no-pane,
 *      PAI_WORKER_AUTOPANE, PAI_WORKER= and the headless-ok override are operator-only.
 *  (a) outside a worker: L0 starts only --class implement|simple (single small change, direct L2)
 *      or --class orchestrate|plan (L1); the worker mode (workers.yaml) picks the models.
 */

import { dropHeredocBodies } from "./heredoc.js";

export interface DelegationDecision { decision: "allow" | "deny"; reason?: string }

export const SEARCH_ROOT_REASON = "search a named directory, never ~ or /";
export const PANE_REASON = "every worker runs behind a visible pane: --no-pane, PAI_WORKER_AUTOPANE, PAI_WORKER= and the headless-ok override are operator-only";
export const L0_ROUTE_REASON = "L0 starts only these routes (the mode in workers.yaml picks the models: speed, balanced, budget): single small change: --class implement (direct L2); several related changes or one larger multi-file change: --class orchestrate (L1, or plan). The orchestrator cuts the work packages and starts the L2 implementers itself.";

/** Quoted text blanked to x (quotes kept), except a quoted string that is exactly $HOME or ${HOME}. */
function blankQuotes(text: string): string {
  return text.split("\n").map((ln) => {
    let o = "", q = "", buf = "";
    for (let i = 0; i < ln.length; i++) {
      const ch = ln[i];
      if (q === "") { o += ch; if (ch === '"' || ch === "'") { q = ch; buf = ""; } continue; }
      if (ch === q) {
        if (q === '"' && (buf === "$HOME" || buf === "${HOME}")) o += buf;
        else if (buf !== "") o += "x";
        o += ch; q = ""; continue;
      }
      if (q === '"' && ch === "\\" && i < ln.length - 1) { buf += ch + ln[i + 1]; i++; continue; }
      buf += ch;
    }
    return q !== "" ? o + "x" : o;
  }).join("\n");
}

const CP = "(?:^|[;&|(]|\\$\\()[ \\t]*";
const RT = "[ \\t](?:/|~|~/|\\$HOME|\\$\\{HOME\\}|\"\\$HOME\"|\"\\$\\{HOME\\}\"|/Users/[^/\\s;&|)]+/?)(?:[\\s;&|)]|$)";
const SEARCH_RES = [
  new RegExp(`${CP}(?:find|fd|rg|du)[^;&|)]*${RT}`, "m"),
  new RegExp(`${CP}grep[ \\t][^;&|)]*(?:-[a-zA-Z]*[rR]|--recursive)[^;&|)]*${RT}`, "m"),
  new RegExp(`${CP}mdfind[ \\t][^;&|)]*-onlyin${RT}`, "m"),
];

export function decideDelegationGate(command: string, env: NodeJS.ProcessEnv): DelegationDecision {
  const sc = dropHeredocBodies(command);
  const sq = blankQuotes(sc);
  if (SEARCH_RES.some((r) => r.test(sq))) return { decision: "deny", reason: SEARCH_ROOT_REASON };
  if (env.PAI_WORKER === "1") return { decision: "allow" };

  const run = /pai\s+worker\s+run(?:\s|$)/m.test(sc);
  if (/headless-ok|PAI_HEADLESS_OK_FILE/.test(sc)
    || (/pai\s+worker\s+(?:run|resume)/.test(sc) && /--no-pane|PAI_WORKER_AUTOPANE|PAI_WORKER=/.test(sc))) {
    return { decision: "deny", reason: PANE_REASON };
  }
  if (run && !/--class[ \t=]+(?:orchestrate|plan|implement|simple)(?:\s|$)/m.test(sc)) {
    return { decision: "deny", reason: L0_ROUTE_REASON };
  }
  return { decision: "allow" };
}

/** The delegation block injected at session start (L0 only). */
export const DELEGATION_BLOCK = [
  "PAI DELEGATION (L0 = this session; all work goes to workers, never done in place)",
  "- Routes by size: single small change -> `pai worker run --class implement` (direct L2); several related or one larger multi-file change -> `--class orchestrate` (L1 cuts work packages, starts the L2 implementers). Other classes are denied from L0.",
  "- Mode picks the models: `pai worker mode` shows it, `pai worker mode speed|balanced|budget` switches it (workers.yaml).",
  "- Start: write the spec with the Write tool, then `pai worker run --label \"<goal>\" -p \"$(cat <spec>)\" --allowedTools 'Read,Edit,Write,Bash,Grep,Glob' --output-format json`, from the project directory with run_in_background: true. The spec states root cause or requirement, exact target, proof required, and whether to commit. No inline prompts, no heredocs.",
  "- Every worker runs behind a visible pane: --no-pane, PAI_WORKER_AUTOPANE, PAI_WORKER= are denied. The answer is the JSON `result` (an AG2 R message): review the diff and re-run the key measurement before believing it.",
  "- Visibility: `pai worker ps`, `follow <id>`, `replay <id>`, `goal <id> \"<text>\"`; wait with `pai worker wait|wait-on`, never sleep-poll.",
  "- Never search recursively from / or ~: name the directory.",
].join("\n");
