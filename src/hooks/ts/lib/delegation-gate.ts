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

import { existsSync, readFileSync } from "node:fs";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { contentToText } from "./transcript-text.js";
import { dropHeredocBodies } from "./heredoc.js";
import { paiHomePath } from "../../../config/pai-home.js";
import { localOnlyMessage, readLocalOnly } from "../../../workers/local-only-state.js";

export interface DelegationDecision { decision: "allow" | "deny"; reason?: string }

export const SEARCH_ROOT_REASON = "search a named directory, never ~ or /";
export const PANE_REASON = "every worker runs behind a visible pane: --no-pane, PAI_WORKER_AUTOPANE, PAI_WORKER= and the headless-ok override are operator-only";
export const L0_ROUTE_REASON = "L0 starts only these routes (the mode in workers.yaml picks the models: speed, balanced, budget): single small change: --class implement (direct L2); several related changes or one larger multi-file change: --class orchestrate (L1, or plan). The orchestrator cuts the work packages and starts the L2 implementers itself.";
export const MODEL_OVERRIDE_REASON = "workers follow the mode chain (`pai worker mode` shows it; speed|balanced|budget switches it): --model and --provider from L0 only when the operator names that model or provider in the request";

/**
 * The local-only window (src/workers/local-only.ts) as the guard sees it: the
 * cloud flags a command asks for, and nothing else — never the class or its
 * possible chain: the hook does not resolve providers, and runWorker's own gate
 * judges what a run actually resolves to (a resolved local provider always
 * starts).
 */
export function localOnlyRefusal(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const w = readLocalOnly();
  if (!w) return null;
  // --approved-by <gatekeeper> carries the gatekeeper's standing approval through
  // the window (run and resume alike); a resume of a worker whose own start the
  // gatekeeper approved needs no flag — the approval follows the job, judged by
  // runWorker's own gate from the old status (cloudApproved), not by this hook.
  const m = /--approved-by(?:=|\s+)["']?([^\s"';|&)]+)/.exec(command);
  // a resume carries no cloud ask of its own (its provider is the old worker's,
  // and runWorker's gate judges it, carried approval included), so only an
  // approved resume passes here; an unapproved one still reads the window's refusal
  if (m && (m[1] === gatekeeperName() || /pai\s+worker\s+resume(?:\s|$)/.test(command))) return null;
  // the flags decide, never the class or its chain (a run that resolves local always starts):
  // --cloud, --where cloud, and --provider naming the native (cloud) provider.
  const asksCloud =
    /--cloud(?:\s|$)/.test(command) ||
    /--where(?:=|\s+)["']?cloud\b/.test(command) ||
    modelOverrides(command).some((o) => o.flag === "provider" && o.value === "anthropic");
  if (!asksCloud) return null;
  return localOnlyMessage(w.label);
}

/** The gatekeeper session name without pulling the daemon config into a hook: env override, else the default. */
function gatekeeperName(): string {
  const g = process.env.PAI_GATEKEEPER_SESSION?.trim();
  return g || "PAI";
}

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

/** Values of --model / --provider in the command (`--model X`, `--model=X`, quoted), each tagged with its flag. */
function modelOverrides(sc: string): Array<{ flag: "model" | "provider"; value: string }> {
  const out: Array<{ flag: "model" | "provider"; value: string }> = [];
  const w = shellWords(sc);
  for (let i = 0; i < w.length; i++) {
    const m = /^--(model|provider)=(.+)$/.exec(w[i]);
    if (m) { out.push({ flag: m[1] as "model" | "provider", value: m[2] }); continue; }
    const f = /^--(model|provider)$/.exec(w[i]);
    if (f && i + 1 < w.length && !w[i + 1].startsWith("-")) out.push({ flag: f[1] as "model" | "provider", value: w[i + 1] });
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
  if (parts.length > 0 && parts.every((p) => words.has(p))) return true;
  // a model family the operator names implies its provider: "build it on
  // sonnet" authorises --provider anthropic. The table is the provider
  // registry (workers.yaml's providers.<name>.models); only the three Claude
  // tier names are a fallback for a gate that cannot read the config.
  const p = value.toLowerCase();
  if (!words.has(p)) {
    // an exact model id names its provider outright: "use glm-5.3-flash"
    // authorises --provider glm
    const fam = p.split(/[^a-z0-9]+/).find((w) => /^[a-z][a-z0-9]*$/.test(w));
    if (!!fam && words.has(fam) && familiesOf(p).includes(fam)) return true;
    // a provider value ("anthropic") is authorised by a family it serves ("sonnet")
    return providerFamilies(p).some((f) => f !== p && words.has(f));
  }
  // the operator named the provider itself, or a family it serves ("build it
  // on sonnet" -> --provider anthropic); "claude" and friends carry no signal
  if (GENERIC_MODEL_PARTS.has(p)) return false;
  const fams = providerFamilies(p);
  return fams.length > 0 && fams.some((f) => words.has(f));
}

/** The shipped fallback for a gate that cannot read the config: the built-in login answers to its name and its tiers answer to theirs. */
const FALLBACK_FAMILIES = new Set(["anthropic", "opus", "sonnet", "haiku"]);

/** The model families provider serves: its own name when the registry lists a model of that family for it, else the fallback table. */
function familiesOf(providerOrId: string): string[] {
  const fam = providerOrId.split(/[^a-z0-9]+/).find((w) => /^[a-z][a-z0-9]*$/.test(w));
  if (fam && registryFamilies().has(fam)) return [fam];
  return FALLBACK_FAMILIES.has(providerOrId) ? [...FALLBACK_FAMILIES] : [];
}

/** The families provider serves by name: its own name when the registry lists a model of that family for it, else the fallback table. */
function providerFamilies(provider: string): string[] {
  if (registryFamilies().has(provider)) return [provider];
  return provider === "anthropic" ? [...FALLBACK_FAMILIES] : [];
}

/** The workers.yaml the gate reads its provider registry from: PAI_WORKERS_YAML, else the PAI_HOME copy (read-only here; no migration notices from a hook). */
function registryPath(): string {
  const override = process.env.PAI_WORKERS_YAML;
  if (override) return override;
  const path = paiHomePath("workers.yaml");
  return existsSync(path) ? path : "";
}

/** The provider registry as a family set: every model id of every provider's models table contributes its first alphabetic word ("glm-5.3-flash" → glm; the built-in anthropic's "sonnet"/"haiku" → themselves). Cached per file+mtime; an unreadable one is the empty set (the fallback stands). */
let familiesCache: { path: string; mtimeMs: number; set: Set<string> } | null = null;
function registryFamilies(): Set<string> {
  const path = registryPath();
  if (!path) return new Set();
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (familiesCache?.path === path && familiesCache.mtimeMs === mtimeMs) return familiesCache.set;
    const raw = readFileSync(path, "utf8");
    const set = new Set<string>();
    let inProviders = false;
    let current: string | null = null;
    let inModels = false;
    for (const ln of raw.split("\n")) {
      if (/^[^\s#]/.test(ln)) {
        inProviders = /^providers:\s*$/.test(ln);
        current = null;
        inModels = false;
        continue;
      }
      if (!inProviders) continue;
      const p = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(ln);
      if (p) { current = p[1]!.toLowerCase(); inModels = false; continue; }
      if (!current) continue;
      if (/^ {4}models:\s*$/.test(ln)) { inModels = true; continue; }
      if (/^ {4}\S/.test(ln)) inModels = false;
      if (!inModels) continue;
      const e = /^ {6}([a-z][a-z0-9-]*):\s*["']?([\w.\-[\]]+)/.exec(ln);
      if (!e) continue;
      const fam = e[2]!.toLowerCase().split(/[^a-z0-9]+/).find((w) => /^[a-z][a-z0-9]*$/.test(w));
      if (fam) set.add(fam);
    }
    familiesCache = { path, mtimeMs, set };
    return set;
  } catch {
    // no readable registry: the fallback table alone
    return new Set();
  }
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
    // --where names where to run; the delegation rule covers it like --provider
    const whereValues = [...sc.matchAll(/--where(?:=|\s+)["']?([^\s"';|&)]+)/g)].map((m) => m[1]!);
    if (overrides.some((o) => !operatorNamesValue(operatorPrompt, o.value)) || whereValues.some((v) => !operatorNamesValue(operatorPrompt, v))) {
      return { decision: "deny", reason: MODEL_OVERRIDE_REASON };
    }
    // --cloud / --where cloud / --provider anthropic is a cloud start the window refuses;
    // --approved-by <gatekeeper> passes; nothing else (never the class) touches the window here
    const lo = localOnlyRefusal(sc, env);
    if (lo) return { decision: "deny", reason: lo };
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
