/**
 * Graph queries over the relations written by relate.ts (kg_triples), optionally joined with an
 * external edge view (external-graph.ts). Output is bounded: at most PER_PREDICATE neighbours per
 * predicate and MAX_LINES lines of text.
 */

import { resolve } from "node:path";
import type { StorageBackend } from "../storage/interface.js";
import type { RelateProject } from "./relate.js";
import { externalEdges } from "./external-graph.js";

export type Domain = "code" | "note" | "external";

export interface Neighbour {
  predicate: string;
  /** "out": the seed points at it; "in": it points at the seed */
  direction: "out" | "in";
  key: string;
  domain: Domain;
  confidence: string;
  label: string;
  /** file:line for code keys when known */
  location: string | null;
  depth: number;
}

export interface RelatedResult {
  seeds: string[];
  groups: Record<string, Neighbour[]>;
  total: number;
  /** one-line notices (external graph absent/unreachable, nothing found) */
  notes: string[];
}

const PER_PREDICATE = 15;
const MAX_LINES = 80;

export function domainOf(key: string): Domain {
  if (key.startsWith("code:")) return "code";
  if (key.startsWith("note:")) return "note";
  return "external";
}

/** code:<slug>[:<path>[#<symbol>]] -> parts (slugs never contain ':') */
export function parseCodeKey(key: string): { slug: string; path: string | null; symbol: string | null } | null {
  if (!key.startsWith("code:")) return null;
  const rest = key.slice(5);
  const i = rest.indexOf(":");
  if (i < 0) return { slug: rest, path: null, symbol: null };
  const slug = rest.slice(0, i);
  const tail = rest.slice(i + 1);
  const h = tail.indexOf("#");
  return h < 0 ? { slug, path: tail, symbol: null } : { slug, path: tail.slice(0, h), symbol: tail.slice(h + 1) };
}

/** a key's own ancestors: symbol -> file -> repo */
function withAncestors(key: string): string[] {
  const p = parseCodeKey(key);
  if (!p) return [key];
  const out = [key];
  if (p.symbol != null && p.path) out.push(`code:${p.slug}:${p.path}`);
  if (p.path) out.push(`code:${p.slug}`);
  return out;
}

/** Turn a key, path or symbol name into typed keys. */
export async function resolveSeeds(backend: StorageBackend, projects: RelateProject[], input: string): Promise<string[]> {
  if (/^(code|note|caseleaf|cite):/.test(input)) return [input];
  const store = backend.codeGraph();
  const out = new Set<string>();
  for (const p of projects) {
    if (p.slug === input) out.add(`code:${p.slug}`);
    const root = resolve(p.root);
    const asPath = input.replace(/^\.?\//, "");
    if (/[/.]/.test(asPath)) {
      const files = await store.listFiles(root);
      if (files.some((f) => f.path === asPath)) out.add(`code:${p.slug}:${asPath}`);
    }
    for (const s of await store.symbolsByName(root, input, 5)) out.add(`code:${p.slug}:${s.file}#${s.qualifiedName}`);
  }
  return [...out].slice(0, 12);
}

async function locate(backend: StorageBackend, roots: Map<string, string>, key: string): Promise<{ label: string; location: string | null }> {
  const p = parseCodeKey(key);
  if (!p) return { label: key, location: null };
  if (!p.path) return { label: `project ${p.slug}`, location: null };
  const root = roots.get(p.slug);
  if (p.symbol == null) return { label: `${p.slug}: ${p.path}`, location: p.path };
  let line: number | null = null;
  if (root) {
    try {
      const sym = (await backend.codeGraph().symbolsInFile(root, p.path)).find((s) => s.qualifiedName === p.symbol);
      if (sym) line = sym.startLine;
    } catch { /* store unavailable: file-level location only */ }
  }
  return { label: `${p.slug}: ${p.symbol}`, location: line ? `${p.path}:${line}` : p.path };
}

export async function related(
  backend: StorageBackend,
  projects: RelateProject[],
  input: string,
  opts: { depth?: number; domains?: Domain[]; external?: boolean } = {},
): Promise<RelatedResult> {
  const depth = Math.min(3, Math.max(1, opts.depth ?? 1));
  const roots = new Map(projects.map((p) => [p.slug, resolve(p.root)]));
  const seeds = await resolveSeeds(backend, projects, input);
  const notes: string[] = [];
  const store = backend.codeGraph();
  const visited = new Set<string>(seeds.flatMap(withAncestors));
  // a whole-repo seed also covers the files inside it (calls-api and duplicates hang off file/symbol keys)
  for (const k of [...visited]) {
    const p = parseCodeKey(k);
    const root = p && !p.path ? roots.get(p.slug) : undefined;
    if (root) for (const f of (await store.listFiles(root)).slice(0, 2000)) visited.add(`code:${p!.slug}:${f.path}`);
  }
  let frontier = [...visited];
  const found: Neighbour[] = [];
  const seenEdge = new Set<string>();
  const seedSet = new Set(visited);

  for (let d = 1; d <= depth && frontier.length; d++) {
    const rows = await store.triplesTouching(frontier, { limit: 600 });
    const ext = opts.external === false ? { edges: [], note: null } : await externalEdges(frontier);
    if (ext.note && !notes.includes(ext.note)) notes.push(ext.note);
    const edges = [
      ...rows.map((r) => ({ s: r.subject, p: r.predicate, o: r.object, c: r.confidence as string })),
      ...ext.edges.map((e) => ({ s: e.src, p: `ext:${e.kind}`, o: e.dst, c: "EXTRACTED" })),
    ];
    const next: string[] = [];
    const front = new Set(frontier);
    for (const e of edges) {
      const out = front.has(e.s);
      const key = out ? e.o : e.s;
      if (!out && !front.has(e.o)) continue;
      const id = `${e.s}|${e.p}|${e.o}`;
      if (seenEdge.has(id)) continue;
      seenEdge.add(id);
      if (!seedSet.has(key)) {
        found.push({ predicate: e.p, direction: out ? "out" : "in", key, domain: domainOf(key), confidence: e.c, label: key, location: null, depth: d });
      }
      if (!visited.has(key)) { visited.add(key); next.push(key); }
    }
    frontier = next;
  }

  const doms = opts.domains?.length ? new Set(opts.domains) : null;
  const groups: Record<string, Neighbour[]> = {};
  let total = 0;
  for (const n of found) {
    if (doms && !doms.has(n.domain)) continue;
    total++;
    const g = (groups[n.predicate] ??= []);
    if (g.length < PER_PREDICATE) g.push(n);
  }
  for (const g of Object.values(groups)) {
    for (const n of g) if (n.domain === "code") Object.assign(n, await locate(backend, roots, n.key));
  }
  if (seeds.length === 0) notes.push(`nothing indexed matches "${input}"`);
  else if (total === 0) notes.push("no relations found (run `pai code relate` to derive them)");
  return { seeds, groups, total, notes };
}

export function formatRelated(r: RelatedResult): string {
  const lines: string[] = [`# related to ${r.seeds.slice(0, 3).join(", ") || "(no match)"}`];
  for (const [pred, list] of Object.entries(r.groups)) {
    lines.push(`\n${pred} (${list.length})`);
    for (const n of list) {
      const arrow = n.direction === "out" ? "->" : "<-";
      const loc = n.location ? `  ${n.location}` : "";
      lines.push(`  ${arrow} ${n.label}${loc}  [${n.confidence}${n.depth > 1 ? `, hop ${n.depth}` : ""}]${n.label === n.key ? "" : `  ${n.key}`}`);
    }
  }
  if (r.total > Object.values(r.groups).reduce((a, g) => a + g.length, 0)) lines.push(`\n(${r.total} neighbours, capped per predicate)`);
  for (const n of r.notes) lines.push(`\nnote: ${n}`);
  return lines.slice(0, MAX_LINES).join("\n");
}

/** Short "related elsewhere" block for code_explore: other projects and notes that touch a symbol. */
export async function relatedElsewhere(
  backend: StorageBackend,
  projects: RelateProject[],
  rootAbs: string,
  symbols: Array<{ file: string; qualifiedName: string }>,
): Promise<string> {
  const self = projects.find((p) => resolve(p.root) === rootAbs);
  if (!self || symbols.length === 0) return "";
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const s of symbols.slice(0, 6)) {
    const key = `code:${self.slug}:${s.file}#${s.qualifiedName}`;
    const r = await related(backend, projects, key, { depth: 1, external: false });
    for (const [pred, list] of Object.entries(r.groups)) {
      for (const n of list) {
        if (parseCodeKey(n.key)?.slug === self.slug) continue;
        const line = `- ${s.qualifiedName} ${n.direction === "out" ? "->" : "<-"} ${pred}: ${n.label}${n.location ? ` (${n.location})` : ""}`;
        if (!seen.has(line) && lines.length < 12) { seen.add(line); lines.push(line); }
      }
    }
  }
  return lines.length ? `\n## Related elsewhere\n${lines.join("\n")}\n` : "";
}
