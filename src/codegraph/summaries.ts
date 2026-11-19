/**
 * Module and repo summaries on top of the code graph.
 *
 * For every module (a directory with source files) and the repo itself: one
 * short text — purpose (1-2 sentences, written by the LOCAL model), entry
 * points, what it depends on and what depends on it (both from the graph, so
 * they are exact). Stored in code_summaries next to the graph, keyed
 * `code:<project-slug>:<path>` with the model and a source hash; regenerated
 * only when that hash changes. The text is also written as a memory chunk so
 * the normal embed pass embeds it and memory_search finds it.
 *
 * The model only ever sees a bounded digest (signatures, one-line doc
 * comments, top refs), never whole files, and is called one module at a time.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { StorageBackend } from "../storage/interface.js";
import { graphRoot, resolveRoot } from "./api.js";
import { sha256 } from "../utils/hash.js";
import type { CodeGraphStore, CodeFileRow, SummaryRow, SymbolRow } from "./store.js";

/** One model call: prompt in, text out (null = no answer). */
export type ModelClient = (prompt: string) => Promise<string | null>;
export interface SummaryModel { name: string; client: ModelClient }

/** Hard cap on what one prompt may carry (chars). */
export const MAX_PROMPT_CHARS = 6000;
const MAX_SYMBOL_LINES = 40;
const MAX_LIST = 8;
const MAX_SUMMARY_CHARS = 900;
/** Synthetic memory project that holds the summary chunks (lessons use 998, the vault 999). */
export const SUMMARY_PROJECT_ID = 997;

export function summaryKey(slug: string, path: string): string {
  return `code:${slug}:${path}`;
}

/** The repo-relative path inside a `code:<slug>:<path>` key; other input is returned as given. */
export function pathOfKey(keyOrPath: string): string {
  const m = /^code:[^:]*:(.*)$/.exec(keyOrPath);
  return m ? m[1] : keyOrPath;
}

const isSource = (f: CodeFileRow) => f.language !== "unknown";
const dirOf = (p: string) => (dirname(p) === "" ? "." : dirname(p));

export interface ModuleInfo {
  /** repo-relative directory */
  path: string;
  files: CodeFileRow[];
  /** hash of the direct files' content hashes */
  hash: string;
}

/** Directories that hold source files directly, with a hash over their files. */
export function listModules(files: CodeFileRow[]): ModuleInfo[] {
  const by = new Map<string, CodeFileRow[]>();
  for (const f of files.filter(isSource)) {
    const d = dirOf(f.path);
    (by.get(d) ?? by.set(d, []).get(d)!).push(f);
  }
  return [...by.entries()]
    .map(([path, fs]) => {
      fs.sort((a, b) => a.path.localeCompare(b.path));
      return { path, files: fs, hash: sha256(fs.map((f) => `${f.path}\0${f.contentHash}`).join("\n")) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** First line of the comment right above a definition, "" when none. */
function docLine(lines: string[], startLine: number): string {
  let i = startLine - 2;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0) return "";
  const raw = lines[i].trim();
  if (!/^(\/\/|\/\*|\*|#|""")/.test(raw) && !raw.endsWith("*/")) return "";
  // walk up to the start of the block, keep its first text line
  let j = i;
  while (j > 0 && /^(\*|\/\/|#)/.test(lines[j - 1].trim()) && !/^\/\*/.test(lines[j].trim())) j--;
  for (let k = j; k <= i; k++) {
    const t = lines[k].trim().replace(/^(\/\*\*?|\*\/|\*|\/\/+|#+)\s?/, "").replace(/\*\/$/, "").trim();
    if (t && !t.startsWith("@")) return t.slice(0, 110);
  }
  return "";
}

function top(counts: Map<string, number>, n = MAX_LIST): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k, c]) => `${k} (${c})`);
}

export interface ModuleFacts {
  entryPoints: string[];
  dependsOn: string[];
  usedBy: string[];
  /** bounded digest of definitions, input of the model prompt */
  digest: string;
}

/** Facts of one module from the graph; reads one-line doc comments from the files. */
export async function moduleFacts(store: CodeGraphStore, root: string, mod: ModuleInfo): Promise<ModuleFacts> {
  const paths = mod.files.map((f) => f.path);
  const syms: SymbolRow[] = [];
  for (const p of paths) syms.push(...(await store.symbolsInFile(root, p)));
  const own = new Set(paths);
  const topLevel = syms.filter((s) => !s.qualifiedName.includes("."));
  const notVars = (xs: SymbolRow[]) => { const k = xs.filter((s) => s.kind !== "variable"); return k.length ? k : xs; };
  const exported = notVars(topLevel.filter((s) => s.exported));
  const entryPoints = (exported.length ? exported : notVars(topLevel)).slice(0, 12).map((s) => `${s.name} (${s.kind})`);

  const dep = new Map<string, number>();
  for (const r of await store.resolveRefs(root, paths)) {
    const t = r.target?.file;
    if (t && !own.has(t)) dep.set(dirOf(t), (dep.get(dirOf(t)) ?? 0) + 1);
  }
  const used = new Map<string, number>();
  for (const e of await store.refsToFiles(root, paths)) {
    if (!own.has(e.fromFile)) used.set(dirOf(e.fromFile), (used.get(dirOf(e.fromFile)) ?? 0) + 1);
  }

  const lines: string[] = [];
  const byFile = new Map<string, SymbolRow[]>();
  for (const s of syms) (byFile.get(s.file) ?? byFile.set(s.file, []).get(s.file)!).push(s);
  let budget = MAX_SYMBOL_LINES;
  for (const f of paths) {
    if (budget <= 0) break;
    if (/\.(test|spec)\./.test(f)) continue;
    const fs = (byFile.get(f) ?? []).filter((s) => s.exported || !s.qualifiedName.includes(".")).slice(0, Math.min(budget, 12));
    if (!fs.length) { lines.push(`${basename(f)}: (no definitions)`); continue; }
    let src: string[] = [];
    try { src = readFileSync(`${root}/${f}`, "utf8").split("\n"); } catch { /* signature only */ }
    lines.push(`${basename(f)}:`);
    for (const s of fs) {
      const doc = docLine(src, s.startLine);
      lines.push(`  ${s.signature.replace(/\s+/g, " ").slice(0, 140) || s.name}${doc ? `  // ${doc}` : ""}`);
      budget--;
    }
  }
  return { entryPoints, dependsOn: top(dep), usedBy: top(used), digest: lines.join("\n") };
}

export function modulePrompt(mod: ModuleInfo, f: ModuleFacts): string {
  const body = [
    `Module: ${mod.path}`,
    `Files: ${mod.files.map((x) => basename(x.path)).slice(0, 30).join(", ")}`,
    `Depends on: ${f.dependsOn.join(", ") || "-"}`,
    `Used by: ${f.usedBy.join(", ") || "-"}`,
    "Definitions:",
    f.digest,
  ].join("\n");
  const head = "Write the purpose of this source module in 1 or 2 plain sentences (max 45 words). Reply with those sentences only: no list, no markdown, no preamble.\n\n";
  return head + body.slice(0, MAX_PROMPT_CHARS - head.length);
}

export function repoPrompt(slug: string, modules: Array<{ path: string; summary: string }>): string {
  const head = `Write the purpose of the repository "${slug}" in 2 plain sentences (max 60 words), from its module summaries. Reply with those sentences only: no list, no markdown, no preamble.\n\n`;
  const body = modules.map((m) => `${m.path}: ${m.summary.split("\n")[0].slice(0, 220)}`).join("\n");
  return head + body.slice(0, MAX_PROMPT_CHARS - head.length);
}

function clean(reply: string | null): string | null {
  if (!reply) return null;
  const t = reply.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```/g, "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, MAX_SUMMARY_CHARS) : null;
}

function render(purpose: string, f: ModuleFacts): string {
  return [
    purpose,
    `Entry points: ${f.entryPoints.join(", ") || "-"}`,
    `Depends on: ${f.dependsOn.join(", ") || "-"}`,
    `Used by: ${f.usedBy.join(", ") || "-"}`,
  ].join("\n");
}

export interface SummarizeResult {
  slug: string;
  modules: number;
  summarized: number;
  unchanged: number;
  failed: number;
  /** stopped early by the time budget */
  budgetHit: boolean;
  ms: number;
}

export interface SummarizeOpts {
  model: SummaryModel;
  slug: string;
  /** only regenerate rows whose source hash changed (default true) */
  changed?: boolean;
  /** wall-clock budget; no new module is started after it */
  maxMs?: number;
  log?: (m: string) => void;
  now?: () => number;
}

/** Store (or replace) the summary as a memory chunk so the embed pass embeds it and memory_search finds it. */
async function writeMemoryChunk(backend: StorageBackend, row: SummaryRow, now: number): Promise<void> {
  const text = `${row.key}\n${row.summary}`;
  const hash = sha256(text);
  await backend.deleteChunksForFile(SUMMARY_PROJECT_ID, row.key);
  await backend.upsertFile({ projectId: SUMMARY_PROJECT_ID, path: row.key, source: "code", tier: "topic", hash, mtime: now, size: text.length });
  await backend.insertChunks([{
    id: sha256(`${row.key}\0${hash}`), projectId: SUMMARY_PROJECT_ID, source: "code", tier: "topic",
    path: row.key, startLine: 1, endLine: text.split("\n").length, hash, text, updatedAt: now,
  }]);
}

/** Summarize every module of an indexed repo, then the repo. One module at a time, sequentially. */
export async function summarizeRepo(backend: StorageBackend, root: string, o: SummarizeOpts): Promise<SummarizeResult> {
  const store = backend.codeGraph();
  const rootAbs = resolve(root);
  const now = o.now ?? Date.now;
  const t0 = now();
  const log = o.log ?? (() => {});
  const onlyChanged = o.changed !== false;
  const mods = listModules(await store.listFiles(rootAbs));
  const res: SummarizeResult = { slug: o.slug, modules: mods.length, summarized: 0, unchanged: 0, failed: 0, budgetHit: false, ms: 0 };
  const texts: Array<{ path: string; summary: string }> = [];
  const keep: string[] = [summaryKey(o.slug, ".")];

  for (const mod of mods) {
    const key = summaryKey(o.slug, mod.path);
    keep.push(key);
    const prev = await store.getSummary(rootAbs, key);
    if (prev && onlyChanged && prev.sourceHash === mod.hash) {
      res.unchanged++;
      texts.push({ path: mod.path, summary: prev.summary });
      continue;
    }
    if (o.maxMs !== undefined && now() - t0 > o.maxMs) { res.budgetHit = true; if (prev) texts.push({ path: mod.path, summary: prev.summary }); continue; }
    const facts = await moduleFacts(store, rootAbs, mod);
    let purpose: string | null = null;
    try { purpose = clean(await o.model.client(modulePrompt(mod, facts))); } catch (e) { log(`${mod.path}: model error ${e instanceof Error ? e.message : String(e)}`); }
    if (!purpose) { res.failed++; if (prev) texts.push({ path: mod.path, summary: prev.summary }); continue; }
    const row: SummaryRow = { key, kind: "module", path: mod.path, summary: render(purpose, facts), model: o.model.name, sourceHash: mod.hash, generatedAt: now() };
    await store.upsertSummary(rootAbs, row);
    await writeMemoryChunk(backend, row, now());
    texts.push({ path: mod.path, summary: row.summary });
    res.summarized++;
    log(`${mod.path}: summarized`);
  }

  // repo summary: hash over the module hashes; regenerated only when a module changed
  const repoKey = summaryKey(o.slug, ".");
  const repoHash = sha256(mods.map((m) => `${m.path}\0${m.hash}`).join("\n"));
  const prevRepo = await store.getSummary(rootAbs, repoKey);
  if (mods.length && !(prevRepo && onlyChanged && prevRepo.sourceHash === repoHash) && !res.budgetHit) {
    let purpose: string | null = null;
    try { purpose = clean(await o.model.client(repoPrompt(o.slug, texts))); } catch (e) { log(`repo: model error ${e instanceof Error ? e.message : String(e)}`); }
    if (purpose) {
      const dir = new Map<string, number>();
      for (const m of mods) dir.set(m.path, m.files.length);
      const row: SummaryRow = {
        key: repoKey, kind: "repo", path: ".",
        summary: `${purpose}\nModules: ${top(dir, 12).map((s) => s.replace(/ \(\d+\)$/, "")).join(", ")}`,
        model: o.model.name, sourceHash: repoHash, generatedAt: now(),
      };
      await store.upsertSummary(rootAbs, row);
      await writeMemoryChunk(backend, row, now());
      res.summarized++;
      log("repo: summarized");
    } else res.failed++;
  } else if (prevRepo && mods.length) res.unchanged++;

  const gone = (await store.listSummaries(rootAbs)).filter((r) => !keep.includes(r.key));
  if (!res.budgetHit && gone.length) {
    await store.pruneSummaries(rootAbs, keep);
    for (const g of gone) await backend.deleteChunksForFile(SUMMARY_PROJECT_ID, g.key);
  }
  res.ms = now() - t0;
  return res;
}

/**
 * The summary for a key, a directory or a file path: the nearest enclosing
 * module's, falling back up the tree to the repo's. Null when none stored.
 */
export async function findSummary(store: CodeGraphStore, root: string, keyOrPath: string): Promise<SummaryRow | null> {
  // keyed by the git toplevel (as everywhere); a linked worktree reads the parent repo's
  const rows = await store.listSummaries(graphRoot(root));
  if (!rows.length) return null;
  const byPath = new Map(rows.map((r) => [r.path, r]));
  let p = pathOfKey(keyOrPath).replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  for (;;) {
    const hit = byPath.get(p);
    if (hit) return hit;
    if (p === ".") return null;
    p = dirOf(p);
  }
}

/** The local model, through the router's local-provider resolution. Throws when none runs — never falls back to a cloud model. */
export async function localSummaryModel(): Promise<SummaryModel> {
  const cfgMod = await import("../workers/config.js");
  const { resolveLocalProvider } = await import("../workers/local-provider.js");
  const { workersLogDir } = await import("../workers/paths.js");
  const { workers } = cfgMod.readWorkersSection();
  let name: string;
  try {
    name = (await resolveLocalProvider(workers, workersLogDir(workers))).name;
  } catch (e) {
    throw new Error(`no local model running — not summarizing with a cloud model (${e instanceof Error ? e.message : String(e)})`);
  }
  const p = workers.providers[name]!;
  const model = cfgMod.resolveModelCapability(p, "default");
  const base = p.baseUrl.replace(/\/+$/, "");
  const openai = p.protocol === "openai";
  const client: ModelClient = async (prompt) => {
    const res = await fetch(openai ? `${base}/chat/completions` : `${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local", "x-api-key": "local", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 400, temperature: 0, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`model endpoint ${res.status}`);
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ type: string; text?: string }> };
    if (openai) return j.choices?.[0]?.message?.content ?? null;
    return (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("") || null;
  };
  return { name: `${name}/${model}`, client };
}
