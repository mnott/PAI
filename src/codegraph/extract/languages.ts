/**
 * Language detection and tree-sitter parser management.
 *
 * Parsers are lazily initialised per language and cached; the web-tree-sitter
 * runtime and each grammar .wasm load on first use, never at import time.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Parser, Language } from "web-tree-sitter";
import { resolveFromModule } from "../../module-paths.js";

export type LanguageId = "typescript" | "javascript" | "swift" | "python" | "unknown";

/** repo-relative path → language id. Unknown extensions get file rows only. */
export function detectLanguage(relPath: string): LanguageId {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  if (base.endsWith(".ts") && !base.endsWith(".d.ts")) return "typescript";
  if (base === ".mts" || base.endsWith(".mts") || base.endsWith(".cts")) return "typescript";
  if (base.endsWith(".tsx")) return "typescript";
  if (/\.(mjs|cjs|jsx|js)$/.test(base)) return "javascript";
  if (base.endsWith(".swift")) return "swift";
  if (base.endsWith(".py") || base.endsWith(".pyi")) return "python";
  return "unknown";
}

/** Grammar wasm file names inside tree-sitter-wasms/out for a language. */
const GRAMMAR_FILES: Record<Exclude<LanguageId, "unknown">, string[]> = {
  typescript: ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"],
  javascript: ["tree-sitter-javascript.wasm"],
  swift: ["tree-sitter-swift.wasm"],
  python: ["tree-sitter-python.wasm"],
};

/** tsx files parse with the TSX grammar; everything else with the plain one. */
function grammarFile(lang: Exclude<LanguageId, "unknown">, relPath: string): string {
  if (lang === "typescript" && relPath.toLowerCase().endsWith(".tsx")) return "tree-sitter-tsx.wasm";
  return GRAMMAR_FILES[lang][0];
}

/**
 * Locate the grammar wasm directory at runtime.
 *
 * From src via tsx the package sits in node_modules next to the source tree;
 * from dist it is still resolved by walking up for a node_modules dir that has
 * it (resolveFromModule is depth-independent, see module-paths.ts). The build
 * also copies the needed grammars into dist/codegraph/grammars and the runtime
 * checks that first, so a hoisted/moved node_modules never breaks indexing.
 */
function grammarDir(): string {
  try {
    const bundled = resolveFromModule(import.meta.url, join("dist", "codegraph", "grammars"));
    if (existsSync(join(bundled, "tree-sitter-typescript.wasm"))) return bundled;
  } catch {
    /* not built — fall through to node_modules */
  }
  return resolveFromModule(import.meta.url, join("node_modules", "tree-sitter-wasms", "out"));
}

let runtimeInit: Promise<void> | null = null;
const parserCache = new Map<string, Parser>();
const languageCache = new Map<string, Language>();

/** One web-tree-sitter runtime for the process; parsers share it. */
function initRuntime(): Promise<void> {
  if (!runtimeInit) runtimeInit = Parser.init();
  return runtimeInit;
}

async function loadLanguage(file: string): Promise<Language> {
  const cached = languageCache.get(file);
  if (cached) return cached;
  const lang = await Language.load(join(grammarDir(), file));
  languageCache.set(file, lang);
  return lang;
}

/** Parser for (language, path), created on first use and cached thereafter. */
export async function parserFor(lang: LanguageId, relPath: string): Promise<Parser | null> {
  if (lang === "unknown") return null;
  const key = `${lang}:${grammarFile(lang, relPath)}`;
  const cached = parserCache.get(key);
  if (cached) return cached;
  await initRuntime();
  const parser = new Parser();
  parser.setLanguage(await loadLanguage(grammarFile(lang, relPath)));
  parserCache.set(key, parser);
  return parser;
}
