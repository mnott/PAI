/**
 * delegation-gate.ts — PAI's own delegation rules for the Bash tool (pure; the hook entry
 * pre-tool-use/delegation-guard.ts does the I/O). They used to live in a hook outside any repo.
 *
 *  (c) every session: no recursive search rooted at / or the home folder.
 *  (b) outside a worker (PAI_WORKER != 1): a worker runs behind a visible pane; --no-pane,
 *      PAI_WORKER_AUTOPANE, PAI_WORKER= and the headless-ok override are operator-only.
 *  (a) outside a worker: L0 starts only --class implement|simple (single small change, direct L2)
 *      or --class orchestrate|plan (L1); the worker mode (workers.yaml) picks the models.
 *  (d) outside a worker: no --model / --provider on `pai worker run|resume` unless the operator
 *      named that model or provider in their latest prompt (the guard reads it from the transcript).
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { contentToText } from "./transcript-text.js";
import { dropHeredocBodies } from "./heredoc.js";

export interface DelegationDecision { decision: "allow" | "deny"; reason?: string }

export const SEARCH_ROOT_REASON = "search a named directory, never ~ or /";
export const PANE_REASON = "every worker runs behind a visible pane: --no-pane, PAI_WORKER_AUTOPANE, PAI_WORKER= and the headless-ok override are operator-only";
export const L0_ROUTE_REASON = "L0 starts only these routes (the mode in workers.yaml picks the models: speed, balanced, budget): single small change: --class implement (direct L2); several related changes or one larger multi-file change: --class orchestrate (L1, or plan). The orchestrator cuts the work packages and starts the L2 implementers itself.";
export const MODEL_OVERRIDE_REASON = "workers follow the mode chain (`pai worker mode` shows it; speed|balanced|budget switches it): --model and --provider from L0 only when the operator names that model or provider in the request";

/** Quote-aware word split: keeps `--model X`, `--model=X` and quoted values (`--model "claude opus 5"`). */
function shellWords(text: string): string[] {
  const words: string[] = [];
  for (const ln of text.split("\n")) {
    let cur = "", q = "";
    for (let i = 0; i < ln.length; i++) {
      const ch = ln[i];
      if (q) { if (ch === q) q = ""; else cur += ch; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = ""; } continue; }
      cur += ch;
    }
    if (cur) words.push(cur);
  }
  return words;
}

/** Values of --model / --provider in the command (`--model X`, `--model=X`, quoted). */
function modelOverrides(sc: string): string[] {
  const out: string[] = [];
  const w = shellWords(sc);
  for (let i = 0; i < w.length; i++) {
    const m = /^(?:--model|--provider)=(.+)$/.exec(w[i]);
    if (m) { out.push(m[1]); continue; }
    if (/^--(?:model|provider)$/.test(w[i]) && i + 1 < w.length && !w[i + 1].startsWith("-")) out.push(w[i + 1]);
  }
  return out;
}

/** Parts that carry no family signal: "claude" in a prompt must not authorise claude-opus-5-5. */
const GENERIC_MODEL_PARTS = new Set([
  "claude", "anthropic", "openai", "google", "gemini", "next", "latest", "preview", "fast", "flash",
  "lite", "mini", "small", "large", "medium", "pro", "max", "plus", "ultra", "standard", "basic",
  "qwen", "deepseek", "moonshot", "version", "model", "provider", "v",
]);

/** True when the operator named this exact value: the full value, or every non-generic part of it, appears as a word in the prompt. */
export function operatorNamesValue(prompt: string | undefined, value: string): boolean {
  if (!prompt) return false;
  const words = new Set(prompt.toLowerCase().match(/[a-z0-9.]+/g) ?? []);
  if (words.has(value.toLowerCase())) return true;
  const parts = value.toLowerCase().split(/[\s/\-._:]+/).filter((p) => /[a-z]/.test(p) && p.length >= 3 && !GENERIC_MODEL_PARTS.has(p));
  return parts.length > 0 && parts.every((p) => words.has(p));
}

/** Last genuine operator prompt in a transcript's tail JSONL (plain text user entries only). */
export function latestOperatorPromptFromJsonl(jsonl: string): string | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: any;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (!e || e.type !== "user" || e.isMeta) continue;
    const content = e.message?.content;
    if (typeof content === "string") {
      const t = content.trim();
      if (!t || t.startsWith("<task-notification>") || t.includes("[SYSTEM NOTIFICATION") || t.startsWith("[Session:")) continue;
      return content;
    }
    if (Array.isArray(content)) {
      // A tool_result is delivered as a user entry: it counts only when the entry has no text block of its own.
      if (!content.some((b: any) => b && typeof b === "object" && b.type === "text")
        && content.some((b: any) => b && typeof b === "object" && b.type === "tool_result")) continue;
      const t = contentToText(content).trim();
      if (!t || t.startsWith("<task-notification>") || t.includes("[SYSTEM NOTIFICATION") || t.startsWith("[Session:")) continue;
      return contentToText(content);
    }
  }
  return undefined;
}

/** The operator's latest prompt from a hook transcript file: reads only the tail, any read error -> undefined (fail closed for the model-override rule). */
export function latestOperatorPrompt(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  try {
    const size = statSync(transcriptPath).size;
    const fd = openSync(transcriptPath, "r");
    try {
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      let text = buf.subarray(0, got).toString("utf8");
      // The first line of a mid-file window is probably cut — drop it.
      if (start > 0) { const nl = text.indexOf("\n"); text = nl < 0 ? "" : text.slice(nl + 1); }
      return latestOperatorPromptFromJsonl(text);
    } finally { closeSync(fd); }
  } catch {
    return undefined;
  }
}

const TAIL_BYTES = 2 * 1024 * 1024;

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

export function decideDelegationGate(command: string, env: NodeJS.ProcessEnv, operatorPrompt?: string): DelegationDecision {
  const sc = dropHeredocBodies(command);
  const sq = blankQuotes(sc);
  if (SEARCH_RES.some((r) => r.test(sq))) return { decision: "deny", reason: SEARCH_ROOT_REASON };
  if (env.PAI_WORKER === "1") return { decision: "allow" };

  // `pai worker run --help` / `-h` asks how to start, it starts nothing: never a route denial
  if (/(?:^|[;&|(]|$)\s*pai\s+worker\s+run\s+(?:--help|-h)(?:\s|$)/m.test(sc)) return { decision: "allow" };
  const run = /pai\s+worker\s+run(?:\s|$)/m.test(sc);
  const workerCmd = /pai\s+worker\s+(?:run|resume)/.test(sc);
  if (/headless-ok|PAI_HEADLESS_OK_FILE/.test(sc)
    || (workerCmd && /--no-pane|PAI_WORKER_AUTOPANE|PAI_WORKER=/.test(sc))) {
    return { decision: "deny", reason: PANE_REASON };
  }
  if (workerCmd) {
    const overrides = modelOverrides(sc);
    if (overrides.some((v) => !operatorNamesValue(operatorPrompt, v))) {
      return { decision: "deny", reason: MODEL_OVERRIDE_REASON };
    }
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
  "- No `--model`/`--provider` unless the operator names that model or provider in the request (the delegation guard enforces this): workers follow the mode and the class map. The Agent tool is denied in this session; every worker, researcher or spotcheck is one `pai worker run`.",
  "- `--tools` lists keep ToolSearch; web research adds WebSearch,WebFetch to --allowedTools.",
  "- Every worker runs behind a visible pane: --no-pane, PAI_WORKER_AUTOPANE, PAI_WORKER= are denied. The answer is the JSON `result` (an AG2 R message): review the diff and re-run the key measurement before believing it.",
  "- Visibility: `pai worker ps`, `follow <id>`, `replay <id>`, `goal <id> \"<text>\"`; wait with `pai worker wait|wait-on`, never sleep-poll.",
  "- Machine needed NOW: `pai freeze [--for 30m]` stops every worker tree and the local model server (nothing killed; new runs queue), `pai thaw` continues all exactly where it was; MCP workers_freeze / workers_thaw. Not from inside a worker.",
  "- During a freeze: a freeze holds new workers; use --now for priority work, or `pai thaw --session <name>`.",
  "- Never search recursively from / or ~: name the directory.",
].join("\n");
