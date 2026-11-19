/**
 * Relations between projects and across domains, derived from the code graphs and notes.
 *
 * Storage: kg_triples (Postgres) or its SQLite twin, through CodeGraphStore.syncTriples. A relation
 * that disappears on re-derivation gets valid_to set, never deleted.
 *
 * Key grammar (subject/object):
 *   code:<project-slug>                       a whole repo
 *   code:<project-slug>:<path>[#<symbol>]     a file or a symbol in it
 *   note:<vault>:<relative path>              a note PAI indexes
 *   caseleaf:doc|mark|card|turn:<id>, caseleaf:passage:<doc>:<sha256>, cite:<citekey>   external, never resolved here
 *
 * Predicates (closed set, RELATE_PREDICATES):
 *   depends-on       package/import dependency of one repo on a sibling repo (manifest)
 *   calls-api        a file uses an HTTP route or MCP tool another project registers
 *   calls-cli        a file invokes the other project's CLI binary (`pai <verb>`, `aibroker <verb>`)
 *   shares-protocol  same message/schema type name in protocol-like files of two projects
 *   duplicates       near-identical function bodies (normalized-token hash) in two projects
 *   mentions         a note links or names a code key or symbol
 *   cites            a note points at an external key
 * Confidence: EXTRACTED (read directly) or INFERRED (matched by name/shape).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { StorageBackend } from "../storage/interface.js";
import type { CodeGraphStore, SymbolRow, TripleSpec } from "./store.js";

export const RELATE_PREDICATES = ["depends-on", "calls-api", "calls-cli", "shares-protocol", "duplicates", "mentions", "cites"] as const;
export type RelatePredicate = (typeof RELATE_PREDICATES)[number];

export interface RelateProject {
  id?: number;
  slug: string;
  root: string;
}

export interface RelateOptions {
  /** limit the written scopes to these slugs (all projects are still read) */
  only?: string[];
  vaultPath?: string;
  /** maximum files the notes pass reads */
  maxNotes?: number;
}

export interface RelateReport {
  projects: number;
  triples: number;
  added: number;
  closed: number;
  kept: number;
  byPredicate: Record<string, number>;
  samples: Array<{ subject: string; predicate: string; object: string }>;
  /** per predicate: the most frequent objects (top 5), with how often each is cited */
  topObjects?: Record<string, Array<{ object: string; count: number }>>;
}

const SRC_EXT = /\.(?:[cm]?[jt]sx?|py|swift)$/;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|node_modules|dist|build)\/|\.(?:test|spec)\.[a-z]+$/i;
const KEYWORDS = new Set(("function return const let var if else for while switch case break continue new this class extends import export from " +
  "async await try catch finally throw typeof instanceof in of def self None True False and or not is lambda with as pass yield func guard " +
  "struct enum protocol init nil true false null undefined public private static override let where do default").split(/\s+/));
const GENERIC_ROUTES = new Set(["/health", "/status", "/api", "/metrics", "/ping", "/version", "/login", "/logout", "/events", "/stream"]);
const GENERIC_TYPE = /(?:Props|Options|Params|Result|State|Context|Handler|Provider|Config|Error|Request|Response)$/;
/** protocol/transport words that appear as plain strings everywhere: never an API name on their own */
const STOP_NAMES = new Set([
  "tool_use", "tool_result", "tool_result", "content_block", "stop_reason", "text_delta",
  "text", "content", "type", "id", "name", "role", "model", "index", "delta", "message", "messages",
  "system", "user", "assistant", "function", "input", "output", "error", "result", "params", "method",
  "jsonrpc", "prompt", "completion", "stream", "data", "event", "events", "status", "state", "action",
  "session", "sessions", "project", "projects", "config", "settings", "version", "health", "healthz",
  "install", "tasks", "task", "done", "list", "get", "post", "delete", "update", "create",
]);

// ---------------------------------------------------------------------------
// per-project facts
// ---------------------------------------------------------------------------

interface FileFacts {
  path: string;
  routes: string[];
  tools: string[];
  /** CLI verbs invoked on the other project's binary (first word after `pai`/`aibroker` in a string or exec call) */
  cliVerbs: Map<string, Set<string>>;
  /** path-like chunks and snake_case names found inside string literals */
  literals: Set<string>;
}

export interface Loaded {
  p: RelateProject;
  files: string[];
  symbols: SymbolRow[];
  facts: FileFacts[];
}

function readSafe(file: string): string | null {
  try {
    if (statSync(file).size > 1_000_000) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const ROUTE_RES = [
  /\.(?:get|post|put|patch|delete|all)\(\s*["'`](\/[A-Za-z0-9_\-/:.{}]*)["'`]/g,
  /@\w+\.(?:get|post|put|patch|delete|route)\(\s*["'](\/[^"']*)["']/g,
];
// MCP tool registrations only: the call form with the name as first argument (same line or the next).
const TOOL_RES = [/(?:server\.tool|registerTool)\(\s*(?:async\s+)?["']([a-z][a-z0-9_]{4,})["']/g];
const LITERAL_RE = /(["'`])((?:\\.|(?!\1)[^\\\n]){3,200}?)\1/g;
const PATHISH_RE = /\/[A-Za-z0-9_-]{2,}(?:\/[A-Za-z0-9_.:{}-]+)*/g;
const SNAKE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
// binaries of the projects relate can link (their registered slugs); `pai <verb>`, `aibroker <verb>`
const CLI_BIN_RE = /\b(pai|aibroker)\s+([a-z][a-z0-9_-]{2,})\b/g;
const CLI_STOP_VERBS = new Set(["the", "this", "is", "are", "was", "and", "or", "to", "of", "do", "does", "not", "returns", "run", "runs"]);

export function extractFacts(path: string, text: string): FileFacts {
  const routes = new Set<string>();
  const tools = new Set<string>();
  const literals = new Set<string>();
  const cliVerbs = new Map<string, Set<string>>();
  for (const re of ROUTE_RES) for (const m of text.matchAll(re)) routes.add(m[1]);
  for (const re of TOOL_RES) for (const m of text.matchAll(re)) tools.add(m[1]);
  for (const m of text.matchAll(LITERAL_RE)) {
    const lit = m[2];
    if (lit.includes("/")) for (const c of lit.match(PATHISH_RE) ?? []) literals.add(c.replace(/\/+$/, ""));
    else if (SNAKE_RE.test(lit) && lit.length >= 8) literals.add(lit);
    for (const cm of lit.matchAll(CLI_BIN_RE)) {
      if (CLI_STOP_VERBS.has(cm[2])) continue;
      const s = cliVerbs.get(cm[1]) ?? new Set();
      s.add(cm[2]);
      cliVerbs.set(cm[1], s);
    }
  }
  // exec/spawn calls: execFile("pai", ["project", ...]) / spawnSync("aibroker", ["sessions", ...])
  for (const m of text.matchAll(/(?:execFile|execFileSync|spawn|spawnSync|execFileAsync)\w*\(\s*["'](pai|aibroker)["']\s*,\s*\[?\s*["']([a-z][a-z0-9_-]{2,})["']/g)) {
    const s = cliVerbs.get(m[1]) ?? new Set();
    s.add(m[2]);
    cliVerbs.set(m[1], s);
  }
  return { path, routes: [...routes], tools: [...tools], cliVerbs, literals };
}

async function loadProject(store: CodeGraphStore, p: RelateProject): Promise<Loaded | null> {
  const files = await store.listFiles(p.root);
  if (files.length === 0) return null;
  const symbols = await store.allSymbols(p.root);
  const facts: FileFacts[] = [];
  for (const f of files) {
    if (!SRC_EXT.test(f.path) || TEST_PATH.test(f.path)) continue;
    const text = readSafe(join(p.root, f.path));
    if (text != null) facts.push(extractFacts(f.path, text));
  }
  return { p, files: files.map((f) => f.path), symbols, facts };
}

// ---------------------------------------------------------------------------
// derivations (pure over Loaded[])
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[_.]+/g, "-");

function manifestDeps(root: string): { name: string[]; deps: Array<{ name: string; path?: string }> } {
  const names: string[] = [];
  const deps: Array<{ name: string; path?: string }> = [];
  const pkg = readSafe(join(root, "package.json"));
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as Record<string, unknown>;
      if (typeof j.name === "string") names.push(j.name);
      for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [n, v] of Object.entries((j[k] ?? {}) as Record<string, string>)) {
          const m = /^(?:file|link):(.+)$/.exec(String(v));
          deps.push({ name: n, path: m ? resolve(root, m[1]) : undefined });
        }
      }
    } catch { /* malformed manifest */ }
  }
  const sw = readSafe(join(root, "Package.swift"));
  if (sw) {
    for (const m of sw.matchAll(/\.package\(\s*(?:name:\s*"[^"]*"\s*,\s*)?path:\s*"([^"]+)"/g)) deps.push({ name: basename(m[1]), path: resolve(root, m[1]) });
    for (const m of sw.matchAll(/\.package\(\s*(?:name:\s*"[^"]*"\s*,\s*)?url:\s*"[^"]*?\/([^/"]+?)(?:\.git)?"/g)) deps.push({ name: m[1] });
    const n = /Package\(\s*name:\s*"([^"]+)"/.exec(sw);
    if (n) names.push(n[1]);
  }
  const py = readSafe(join(root, "pyproject.toml"));
  if (py) {
    const n = /^\s*name\s*=\s*"([^"]+)"/m.exec(py);
    if (n) names.push(n[1]);
    for (const blk of py.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const m of blk[1].matchAll(/"([A-Za-z0-9_.-]+)/g)) deps.push({ name: m[1] });
    }
  }
  const req = readSafe(join(root, "requirements.txt"));
  if (req) for (const l of req.split("\n")) { const m = /^([A-Za-z0-9_.-]+)/.exec(l.trim()); if (m) deps.push({ name: m[1] }); }
  return { name: names, deps };
}

export function deriveDependsOn(all: Loaded[]): TripleSpec[] {
  const out: TripleSpec[] = [];
  const bySibling = new Map<string, Loaded>();
  const byRoot = new Map<string, Loaded>();
  const manifests = new Map<string, ReturnType<typeof manifestDeps>>();
  for (const l of all) {
    const m = manifestDeps(l.p.root);
    manifests.set(l.p.slug, m);
    for (const n of m.name) bySibling.set(norm(n), l);
    bySibling.set(norm(basename(l.p.root)), l);
    byRoot.set(resolve(l.p.root), l);
  }
  for (const l of all) {
    const seen = new Set<string>();
    for (const d of manifests.get(l.p.slug)!.deps) {
      const target = (d.path ? byRoot.get(d.path) : undefined) ?? bySibling.get(norm(d.name));
      if (!target || target.p.slug === l.p.slug || seen.has(target.p.slug)) continue;
      seen.add(target.p.slug);
      out.push({ subject: `code:${l.p.slug}`, predicate: "depends-on", object: `code:${target.p.slug}`, confidence: "EXTRACTED", projectId: l.p.id });
    }
  }
  return out;
}

function routeMatches(provider: string, consumer: string): boolean {
  const ps = provider.split("?")[0].split("/").filter((s) => s !== "");
  const cs = consumer.split("?")[0].split("/").filter((s) => s !== "");
  if (ps.length === 0 || cs.length < ps.filter((s) => !/^[:{]/.test(s)).length) return false;
  const isParam = (s: string) => /^[:{]/.test(s);
  for (let i = 0; i < ps.length; i++) {
    if (i >= cs.length) return ps.slice(i).every(isParam) && i >= 2;
    if (!isParam(ps[i]) && ps[i] !== cs[i]) return false;
  }
  return cs.length === ps.length;
}

/** A name is an API only if it is specific enough: length >= 4 and not a protocol word. */
function isSpecificName(name: string): boolean {
  return name.length >= 4 && !STOP_NAMES.has(name);
}

export function deriveCallsApi(all: Loaded[]): TripleSpec[] {
  const out: TripleSpec[] = [];
  type Def = { slug: string; file: string; name: string; tool: boolean };
  const defs: Def[] = [];
  for (const l of all) {
    for (const f of l.facts) {
      for (const r of f.routes) if (r.length >= 6 && !GENERIC_ROUTES.has(r) && r.split("/").filter(Boolean).length >= 1) defs.push({ slug: l.p.slug, file: f.path, name: r, tool: false });
      for (const t of f.tools) if (isSpecificName(t)) defs.push({ slug: l.p.slug, file: f.path, name: t, tool: true });
    }
  }
  const toolCount = new Map<string, Set<string>>();
  for (const d of defs) if (d.tool) { const s = toolCount.get(d.name) ?? new Set(); s.add(d.slug); toolCount.set(d.name, s); }
  const seen = new Set<string>();
  for (const l of all) {
    for (const f of l.facts) {
      for (const d of defs) {
        if (d.slug === l.p.slug) continue;
        if (d.tool && (toolCount.get(d.name)?.size ?? 0) > 2) continue;
        const hit = d.tool ? f.literals.has(d.name) : [...f.literals].some((c) => c.startsWith("/") && routeMatches(d.name, c));
        if (!hit) continue;
        const subject = `code:${l.p.slug}:${f.path}`;
        const object = `code:${d.slug}:${d.file}#${d.name}`;
        const k = `${subject}|calls-api|${object}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ subject, predicate: "calls-api", object, confidence: d.tool ? "EXTRACTED" : "INFERRED", projectId: l.p.id });
      }
    }
  }
  return out;
}

/** calls-cli: a file invokes the other project's binary (`pai <verb>`, `aibroker <verb>`). The target is
 *  the provider repo itself — verb strings are documentation-ish and point at no specific file. */
export function deriveCallsCli(all: Loaded[]): TripleSpec[] {
  const out: TripleSpec[] = [];
  const byBin = new Map<string, Array<Loaded>>();
  for (const l of all) {
    const bin = basename(resolve(l.p.root)).toLowerCase();
    if (bin !== "pai" && bin !== "aibroker") continue;
    const list = byBin.get(bin) ?? [];
    list.push(l);
    byBin.set(bin, list);
  }
  const seen = new Set<string>();
  for (const l of all) {
    for (const f of l.facts) {
      for (const [bin, verbs] of f.cliVerbs) {
        const targets = (byBin.get(bin) ?? []).filter((t) => t.p.slug !== l.p.slug);
        if (targets.length === 0) continue;
        const subject = `code:${l.p.slug}:${f.path}`;
        for (const verb of [...verbs].sort()) {
          for (const t of targets) {
            const object = `code:${t.p.slug}#${verb}`;
            const k = `${subject}|calls-cli|${object}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ subject, predicate: "calls-cli", object, confidence: "EXTRACTED", projectId: l.p.id });
          }
        }
      }
    }
  }
  return out;
}

export function deriveSharesProtocol(all: Loaded[]): TripleSpec[] {
  const byName = new Map<string, Array<{ l: Loaded; s: SymbolRow }>>();
  for (const l of all) {
    for (const s of l.symbols) {
      if (!["interface", "type", "struct", "protocol", "enum", "class"].includes(s.kind)) continue;
      if (s.name.length < 8 || s.name.includes(".") || !/^[A-Z][A-Za-z0-9]+$/.test(s.name) || GENERIC_TYPE.test(s.name)) continue;
      if (!/(protocol|message|schema|wire|types?|models?|contract)/i.test(s.file) || TEST_PATH.test(s.file)) continue;
      const list = byName.get(s.name) ?? [];
      if (!list.some((e) => e.l === l)) list.push({ l, s });
      byName.set(s.name, list);
    }
  }
  const out: TripleSpec[] = [];
  const perPair = new Map<string, number>();
  for (const list of byName.values()) {
    if (list.length < 2 || list.length > 4) continue;
    list.sort((a, b) => a.l.p.slug.localeCompare(b.l.p.slug));
    const [a, ...rest] = list;
    for (const b of rest) {
      const pair = `${a.l.p.slug}|${b.l.p.slug}`;
      const n = perPair.get(pair) ?? 0;
      if (n >= 200) continue;
      perPair.set(pair, n + 1);
      out.push({
        subject: `code:${a.l.p.slug}:${a.s.file}#${a.s.qualifiedName}`, predicate: "shares-protocol",
        object: `code:${b.l.p.slug}:${b.s.file}#${b.s.qualifiedName}`, confidence: "INFERRED", projectId: a.l.p.id,
      });
    }
  }
  return out;
}

const TOKEN_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\S/g;

/** Normalized token hash of a function body: comments out, identifiers/strings/numbers abstracted. */
export function bodyHash(src: string): { hash: string; tokens: number } {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)(?:\/\/|#).*$/gm, "$1");
  const toks = (stripped.match(TOKEN_RE) ?? []).map((t) => {
    if (/^["'`]/.test(t)) return "S";
    if (/^\d/.test(t)) return "N";
    if (/^[A-Za-z_$]/.test(t)) return KEYWORDS.has(t) ? t : "I";
    return t;
  });
  return { hash: createHash("sha1").update(toks.join(" ")).digest("hex"), tokens: toks.length };
}

export const DUP_MIN_LINES = 8;
export const DUP_MIN_TOKENS = 60;

export function deriveDuplicates(all: Loaded[]): TripleSpec[] {
  const groups = new Map<string, Array<{ l: Loaded; s: SymbolRow }>>();
  for (const l of all) {
    const byFile = new Map<string, SymbolRow[]>();
    for (const s of l.symbols) {
      if (s.kind !== "function" && s.kind !== "method") continue;
      if (s.endLine - s.startLine + 1 < DUP_MIN_LINES || s.endLine - s.startLine > 250 || TEST_PATH.test(s.file)) continue;
      const a = byFile.get(s.file) ?? [];
      a.push(s);
      byFile.set(s.file, a);
    }
    for (const [file, syms] of byFile) {
      const text = readSafe(join(l.p.root, file));
      if (text == null) continue;
      const lines = text.split("\n");
      for (const s of syms) {
        const { hash, tokens } = bodyHash(lines.slice(s.startLine - 1, s.endLine).join("\n"));
        if (tokens < DUP_MIN_TOKENS) continue;
        const g = groups.get(hash) ?? [];
        if (!g.some((e) => e.l === l)) g.push({ l, s });
        groups.set(hash, g);
      }
    }
  }
  const out: TripleSpec[] = [];
  for (const g of groups.values()) {
    if (g.length < 2 || g.length > 6) continue;
    g.sort((a, b) => a.l.p.slug.localeCompare(b.l.p.slug));
    const [a, ...rest] = g;
    for (const b of rest) {
      out.push({
        subject: `code:${a.l.p.slug}:${a.s.file}#${a.s.qualifiedName}`, predicate: "duplicates",
        object: `code:${b.l.p.slug}:${b.s.file}#${b.s.qualifiedName}`, confidence: "INFERRED", projectId: a.l.p.id,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

export function listNotes(vault: string, max: number): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) out.push(full);
    }
  };
  walk(vault);
  return out;
}

export function deriveFromNote(
  noteKey: string,
  text: string,
  idx: { slugs: Set<string>; paths: Map<string, string[]>; symbols: Map<string, Array<{ slug: string; file: string; q: string }>> },
): TripleSpec[] {
  const out: TripleSpec[] = [];
  const seen = new Set<string>();
  const add = (predicate: "mentions" | "cites", object: string, confidence: "EXTRACTED" | "INFERRED") => {
    const k = `${predicate}|${object}`;
    if (seen.has(k) || seen.size >= 40) return;
    seen.add(k);
    out.push({ subject: noteKey, predicate, object, confidence });
  };
  const candidates: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) candidates.push(m[1].trim());
  for (const m of text.matchAll(/`([^`\n]{3,120})`/g)) candidates.push(m[1].trim());
  for (const c of candidates) {
    if (idx.slugs.has(c)) { add("mentions", `code:${c}`, "EXTRACTED"); continue; }
    const asPath = c.replace(/^\.?\//, "").replace(/:\d+(?::\d+)?$/, "");
    if (/[/.]/.test(asPath) && SRC_EXT.test(asPath)) {
      const hit = idx.paths.get(asPath);
      if (hit && hit.length === 1) { add("mentions", `code:${hit[0]}:${asPath}`, "EXTRACTED"); continue; }
    }
    const name = c.replace(/\(.*$/, "").replace(/^[A-Za-z0-9_]+\./, (m) => (idx.symbols.has(m.slice(0, -1)) ? "" : m));
    const defs = idx.symbols.get(name);
    if (defs && defs.length <= 2) for (const d of defs) add("mentions", `code:${d.slug}:${d.file}#${d.q}`, "INFERRED");
  }
  for (const m of text.matchAll(/caseleaf:\/\/(doc|mark|card|turn)\/([A-Za-z0-9-]+)/g)) add("cites", `caseleaf:${m[1]}:${m[2]}`, "EXTRACTED");
  for (const m of text.matchAll(/caseleaf:\/\/passage\/([A-Za-z0-9-]+)\/([0-9a-f]{64})/g)) add("cites", `caseleaf:passage:${m[1]}:${m[2]}`, "EXTRACTED");
  // bibliography citekeys only: the Zettelkasten form [[@key]…] / [; @key], never a bare [@handle …] mention
  for (const m of text.matchAll(/\[\[\s*(?:[^\]]*?;\s*)?@([A-Za-z][\w:.-]*[A-Za-z0-9])\s*\]\]/g)) add("cites", `cite:${m[1]}`, "EXTRACTED");
  for (const m of text.matchAll(/\[[^\[\]]*?;\s*@([A-Za-z][\w:.-]*[A-Za-z0-9])[^\]]*\]/g)) add("cites", `cite:${m[1]}`, "EXTRACTED");
  return out;
}

function symbolIndex(all: Loaded[]) {
  const symbols = new Map<string, Array<{ slug: string; file: string; q: string }>>();
  const paths = new Map<string, string[]>();
  for (const l of all) {
    for (const f of l.files) { const a = paths.get(f) ?? []; a.push(l.p.slug); paths.set(f, a); }
    for (const s of l.symbols) {
      if (!s.exported || s.name.length < 6 || TEST_PATH.test(s.file)) continue;
      if (!(/[a-z][A-Z]/.test(s.name) || s.name.includes("_") || /^[A-Z][a-z]+[A-Z]/.test(s.name))) continue;
      const a = symbols.get(s.name) ?? [];
      a.push({ slug: l.p.slug, file: s.file, q: s.qualifiedName });
      symbols.set(s.name, a);
    }
  }
  return { slugs: new Set(all.map((l) => l.p.slug)), paths, symbols };
}

/** Drop triples repeating the same (subject, predicate, object). */
export function dedupeTriples(specs: TripleSpec[]): TripleSpec[] {
  const seen = new Set<string>();
  const out: TripleSpec[] = [];
  for (const t of specs) {
    const k = `${t.subject} ${t.predicate} ${t.object}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Derive every relation and sync it into kg_triples, one scope per source project plus "notes". */
export async function relate(backend: StorageBackend, projects: RelateProject[], opts: RelateOptions = {}): Promise<RelateReport> {
  const store = backend.codeGraph();
  const all: Loaded[] = [];
  for (const p of projects) {
    const l = await loadProject(store, { ...p, root: resolve(p.root) });
    if (l) all.push(l);
  }
  const triples: TripleSpec[] = dedupeTriples([
    ...deriveDependsOn(all), ...deriveCallsApi(all), ...deriveCallsCli(all), ...deriveSharesProtocol(all), ...deriveDuplicates(all),
  ]);
  const slugOfKey = (k: string) => k.split(":")[1];
  const scopes = new Map<string, TripleSpec[]>();
  for (const l of all) scopes.set(`relate:${l.p.slug}`, []);
  for (const t of triples) scopes.get(`relate:${slugOfKey(t.subject)}`)?.push(t);

  const notesOn = !opts.only && opts.vaultPath && existsSync(opts.vaultPath);
  if (notesOn) {
    const vault = resolve(opts.vaultPath!);
    const idx = symbolIndex(all);
    const noteTriples: TripleSpec[] = [];
    for (const f of listNotes(vault, opts.maxNotes ?? 30000)) {
      const text = readSafe(f);
      if (text == null) continue;
      const rel = f.slice(vault.length + 1);
      noteTriples.push(...deriveFromNote(`note:${basename(vault)}:${rel}`, text, idx));
    }
    scopes.set("relate:notes", dedupeTriples(noteTriples));
  }

  const report: RelateReport = { projects: all.length, triples: 0, added: 0, closed: 0, kept: 0, byPredicate: {}, samples: [] };
  for (const [scope, specs] of scopes) {
    if (opts.only && !opts.only.includes(scope.slice("relate:".length))) continue;
    const r = await store.syncTriples(scope, specs);
    report.added += r.added; report.closed += r.closed; report.kept += r.kept;
    report.triples += specs.length;
    for (const t of specs) report.byPredicate[t.predicate] = (report.byPredicate[t.predicate] ?? 0) + 1;
  }
  const perPred = new Map<string, Array<{ subject: string; predicate: string; object: string }>>();
  for (const specs of scopes.values()) for (const t of specs) {
    const list = perPred.get(t.predicate) ?? [];
    if (list.length < 5) list.push({ subject: t.subject, predicate: t.predicate, object: t.object });
    perPred.set(t.predicate, list);
  }
  report.samples = [...perPred.values()].flat();
  const objCounts = new Map<string, Map<string, number>>();
  for (const specs of scopes.values()) for (const t of specs) {
    const m = objCounts.get(t.predicate) ?? new Map();
    m.set(t.object, (m.get(t.object) ?? 0) + 1);
    objCounts.set(t.predicate, m);
  }
  report.topObjects = Object.fromEntries([...objCounts].map(([p, m]) => [
    p, [...m].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([object, count]) => ({ object, count })),
  ]));
  return report;
}
