/**
 * Ref resolution: link extracted refs to concrete symbols in the same repo.
 *
 * Rules:
 *  - import refs carry a module path; TS/JS resolve it through the importer's
 *    directory (relative paths, index files, .js→.ts mapping), Python through
 *    dotted module paths (module file or package __init__). Swift is one
 *    module per repo, so imports never point at a file.
 *  - name refs (call / extends / implements / references) link by exact symbol
 *    name match — for TS/JS/Python only when the defining file is imported by
 *    the referrer or holds the ref itself; Swift links any same-repo match.
 *  - names on an import line (`import { x } from "./m"`) follow the module's
 *    symbols even when `x` is never referenced bare in the importer.
 *  - unresolved refs keep the bare to_name with to_symbol_id NULL; they are
 *    retried whenever a file changes (resolveAffected).
 */

import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { CodeGraphStore, ResolvedRefRow, SymbolRow } from "./store.js";

const TS_JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const PY_SUFFIXES = [".py", "/__init__.py"];

function tryFile(root: string, relNoExt: string, exts: string[]): string | null {
  for (const ext of exts) {
    const candidate = `${relNoExt}${ext}`;
    if (existsSync(join(root, candidate))) return candidate.replace(/\\/g, "/");
  }
  // directory import → index file
  for (const ext of TS_JS_EXTS) {
    const candidate = join(relNoExt, `index${ext}`).replace(/\\/g, "/");
    if (existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

/** resolve an import module string to a repo-relative file path, or null */
export function resolveModulePath(root: string, lang: string, fromPath: string, module: string): string | null {
  if (lang === "typescript" || lang === "javascript") {
    if (!module.startsWith(".")) return null; // bare specifier = node_modules / not repo code
    const rel = join(dirname(fromPath), module).replace(/\\/g, "/");
    const ext = extname(rel);
    if (/\.(js|jsx|mjs|cjs)$/.test(ext)) {
      // TS source imports its output extension: ./m.js → m.ts(x) first
      const swapped = tryFile(root, rel.slice(0, -ext.length), [".ts", ".tsx", ".mts", ".cts"]);
      if (swapped) return swapped;
    }
    return tryFile(root, ext ? rel.slice(0, -ext.length) : rel, TS_JS_EXTS);
  }
  if (lang === "python") {
    const parts = module.split(".").filter(Boolean);
    if (parts.length === 0) return null;
    const asFile = tryFile(root, parts.join("/"), PY_SUFFIXES);
    if (asFile) return asFile;
    // relative import from the importer's directory
    const rel = join(dirname(fromPath), ...parts).replace(/\\/g, "/");
    for (const suffix of PY_SUFFIXES) {
      const candidate = `${rel}${suffix}`;
      if (existsSync(join(root, candidate))) return candidate.replace(/\\/g, "/");
    }
    return null;
  }
  return null; // swift / unknown
}

export function langFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (/\.(ts|tsx|mts|cts)$/.test(base)) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/.test(base)) return "javascript";
  if (base.endsWith(".swift")) return "swift";
  if (/\.(py|pyi)$/.test(base)) return "python";
  return "unknown";
}

/** candidate symbols for a name ref: exact name, then qualified-name tail */
function candidatesForName(symbols: SymbolRow[], name: string): SymbolRow[] {
  const direct = symbols.filter((s) => s.name === name);
  if (direct.length) return direct;
  return symbols.filter((s) => s.qualifiedName === name || s.qualifiedName.endsWith(`.${name}`));
}

/**
 * Link a batch of unresolved refs against the repo's symbols. Returns how many
 * got linked. Nothing is deleted: refs that stay unresolved keep their bare
 * to_name and are retried on the next change.
 */
export async function resolveRefs(store: CodeGraphStore, root: string, refs: ResolvedRefRow[]): Promise<number> {
  const pending = refs.filter((r) => r.toSymbolId == null && r.kind !== "import");
  if (pending.length === 0) return 0;

  // one repo-wide symbol load; per-file views are filtered from it
  const all = await store.allSymbols(root);
  const byFile = new Map<string, SymbolRow[]>();
  for (const s of all) {
    let list = byFile.get(s.file);
    if (!list) { list = []; byFile.set(s.file, list); }
    list.push(s);
  }
  const symbolsOf = (file: string): SymbolRow[] => byFile.get(file) ?? [];

  // import edges per importing file: target repo paths (from resolved module paths)
  const importTargets = new Map<string, Set<string>>();
  /** module string on an import line, so names on that line follow the module */
  const moduleByLine = new Map<string, Map<number, string>>();
  for (const ref of pending) {
    if (importTargets.has(ref.fromFile)) continue;
    const fileRefs = await store.resolveRefs(root, [ref.fromFile]);
    const set = new Set<string>();
    const lines = new Map<number, string>();
    for (const r of fileRefs) {
      if (r.kind !== "import") continue;
      const target = resolveModulePath(root, langFromPath(ref.fromFile), ref.fromFile, r.toName);
      if (target) set.add(target);
      lines.set(r.line, r.toName);
    }
    importTargets.set(ref.fromFile, set);
    moduleByLine.set(ref.fromFile, lines);
  }

  let linked = 0;
  for (const ref of pending) {
    const lang = langFromPath(ref.fromFile);
    let pool: SymbolRow[];
    if (lang === "swift") {
      pool = all; // one module: any same-repo match counts
    } else {
      const own = symbolsOf(ref.fromFile);
      const imported: SymbolRow[] = [];
      for (const target of importTargets.get(ref.fromFile) ?? []) imported.push(...symbolsOf(target));
      pool = [...own, ...imported];
    }

    let candidates = candidatesForName(pool, ref.toName);
    // a name sitting on an import line follows that module's symbols
    if (candidates.length === 0 && ref.kind === "references") {
      const mod = moduleByLine.get(ref.fromFile)?.get(ref.line);
      if (mod) {
        const target = resolveModulePath(root, lang, ref.fromFile, mod);
        if (target) candidates = candidatesForName(symbolsOf(target), ref.toName);
      }
    }
    if (candidates.length === 0) continue;

    const best =
      candidates.find((c) => c.file === ref.fromFile) ??
      candidates.find((c) => c.exported) ??
      candidates[0];
    await store.setRefTarget(ref.id, best.id);
    linked++;
  }
  return linked;
}

/** Re-resolve refs affected by changed/deleted files: the unresolved refs of
 *  those files plus refs whose target symbol was deleted (brokenRefIds). */
export async function resolveAffected(
  store: CodeGraphStore,
  root: string,
  changedPaths: string[],
  brokenRefIds: number[],
): Promise<number> {
  const refs: ResolvedRefRow[] = [];
  if (changedPaths.length > 0) refs.push(...(await store.unresolvedRefsInFiles(root, changedPaths)));
  if (brokenRefIds.length > 0) {
    const broken = new Set(brokenRefIds);
    for (const r of await store.unresolvedRefsInFiles(root, [])) if (broken.has(r.id)) refs.push(r);
  }
  // de-dup by id
  const seen = new Set<number>();
  const unique = refs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  return resolveRefs(store, root, unique);
}
