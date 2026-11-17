/**
 * Tree-sitter extraction: symbols and refs from one source file.
 *
 * One cursor walk per file maintains the parent chain (so nested definitions
 * get qualified names like `Class.method`), then dispatches on node type per
 * language. Calls, imports, extends/implements and bare identifier references
 * are recorded as refs carrying the index of the enclosing symbol; linking to
 * concrete symbols happens later in resolve.ts.
 */

import { createHash } from "node:crypto";
import type { Tree, Parser } from "web-tree-sitter";
import { detectLanguage, parserFor, type LanguageId } from "./languages.js";
import type { FileRecord, RefRecord, SymbolKind, SymbolRecord } from "../store.js";

export interface ExtractInput {
  /** repo-relative posix path */
  path: string;
  content: string;
  mtime: number;
  size?: number;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

import type { Node } from "web-tree-sitter";

/** namedChildren is typed (Node|null)[]; this filters the nulls away */
function named(node: Node): Node[] {
  return named(node).filter((c): c is Node => c != null);
}

/** declaration text from the statement start up to (not including) its body */
function signatureOf(node: Node, source: string): string {
  const body = node.childForFieldName("body");
  const end = body ? body.startIndex : node.endIndex;
  return source.slice(node.startIndex, Math.min(end, node.startIndex + 400)).replace(/\s+/g, " ").trim();
}

/** first line of a definition — the variable-declarator form */
function firstLineOf(node: Node, source: string): string {
  return source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 400)).split("\n")[0].trim();
}

const TS_DEF_NODES: Record<string, SymbolKind> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  type_alias_declaration: "type",
};

const PY_DEF_NODES: Record<string, SymbolKind> = {
  function_definition: "function",
  class_definition: "class",
};

const SWIFT_DEF_NODES: Record<string, SymbolKind> = {
  protocol_declaration: "protocol",
  struct_declaration: "struct",
  class_declaration: "class",
  actor_declaration: "class",
  enum_declaration: "enum",
  extension_declaration: "class",
  typealias_declaration: "type",
  property_declaration: "variable",
  function_declaration: "function",
  init_declaration: "method",
  deinit_declaration: "method",
  subscript_declaration: "method",
};

/** container node types that prefix a child's qualified name (Class.method) */
const CONTAINERS: Record<Exclude<LanguageId, "unknown">, Set<string>> = {
  typescript: new Set(["class_declaration", "abstract_class_declaration", "interface_declaration", "enum_declaration", "class_body", "interface_body", "enum_body", "object"]),
  javascript: new Set(["class_declaration", "class_body", "object"]),
  python: new Set(["class_definition"]),
  swift: new Set(["class_declaration", "struct_declaration", "protocol_declaration", "extension_declaration", "actor_declaration", "enum_declaration", "class_body", "protocol_body", "enum_class_body", "enum_body"]),
};

function containerPrefix(parents: Array<{ type: string; name: string | null }>, lang: LanguageId): string | null {
  const containers = CONTAINERS[lang as Exclude<LanguageId, "unknown">];
  for (let i = parents.length - 1; i >= 0; i--) {
    if (containers.has(parents[i].type) && parents[i].name) return parents[i].name!;
  }
  return null;
}

/** name of a definition node across the per-language field shapes */
function defName(node: Node, lang: LanguageId): string | null {
  const direct = node.childForFieldName("name");
  if (!direct) return null;
  if (lang === "swift") {
    if (direct.type === "simple_identifier" || direct.type === "type_identifier") return direct.text;
    if (direct.type === "user_type") {
      const id = direct.descendantsOfType("type_identifier")[0] ?? direct.descendantsOfType("simple_identifier")[0];
      if (id) return id.text;
    }
    if (direct.type === "pattern") return direct.childForFieldName("bound_identifier")?.text ?? null;
    return null;
  }
  if (lang === "python") return direct.type === "identifier" ? direct.text : null;
  // TS/JS: definitions name themselves with identifier/type_identifier only
  return direct.type === "identifier" || direct.type === "type_identifier" ? direct.text : null;
}

/** exported flag: TS/JS = export_statement ancestor; Python = top level; Swift = public/open */
function isTsExported(node: Node): boolean {
  let n = node.parent;
  while (n) {
    if (n.type === "export_statement") return true;
    if (n.type === "program" || n.type === "class_body") break;
    n = n.parent;
  }
  return false;
}

function swiftIsPublic(node: Node): boolean {
  const mods = named(node).find((c) => c.type === "modifiers");
  if (!mods) return false;
  const t = mods.text;
  return t.includes("public") || t.includes("open") || t.includes("package");
}

/** last callable name of a call target (`a.b.c()` → c, `new Foo()` → Foo) */
function calleeName(fnNode: Node | null): string | null {
  if (!fnNode) return null;
  switch (fnNode.type) {
    case "identifier":
    case "property_identifier":
    case "shorthand_property_identifier":
    case "simple_identifier":
      return fnNode.text;
    case "member_expression":
      return fnNode.childForFieldName("property")?.text ?? null;
    case "attribute":
      return fnNode.childForFieldName("attribute")?.text ?? null;
    case "new_expression":
      return calleeName(fnNode.childForFieldName("constructor"));
    case "navigation_expression": {
      const ids = fnNode.descendantsOfType("simple_identifier").filter((x): x is Node => x != null);
      return ids.length ? ids[ids.length - 1].text : null;
    }
    default:
      return null;
  }
}

/** import specifiers + module source of an import node */
interface ImportInfo { module: string | null; names: Array<{ imported: string; local: string }> }

function parseImport(node: Node, lang: LanguageId): ImportInfo | null {
  if (lang === "typescript" || lang === "javascript") {
    if (node.type !== "import_statement") return null;
    const src = node.childForFieldName("source")?.text.replace(/^['"]|['"]$/g, "") ?? null;
    const names: Array<{ imported: string; local: string }> = [];
    for (const child of named(node)) {
      if (child.type !== "import_clause") continue;
      for (const c of named(child)) {
        if (c.type === "identifier") names.push({ imported: "default", local: c.text });
        else if (c.type === "namespace_import") names.push({ imported: "*", local: c.child(0)?.text ?? "" });
        else if (c.type === "named_imports") {
          for (const spec of named(c)) {
            const name = spec.childForFieldName("name")?.text;
            const alias = spec.childForFieldName("alias")?.text ?? name;
            if (name && alias) names.push({ imported: name, local: alias });
          }
        }
      }
    }
    return { module: src, names };
  }
  if (lang === "python") {
    const collect = (c: Node, names: Array<{ imported: string; local: string }>, modules: string[]) => {
      if (c.type === "dotted_name" || c.type === "identifier") {
        modules.push(c.text);
        names.push({ imported: c.text, local: c.type === "dotted_name" ? c.text.split(".")[0] : c.text });
      } else if (c.type === "aliased_import") {
        const n = c.childForFieldName("name");
        if (n) { modules.push(n.text); names.push({ imported: n.text, local: c.childForFieldName("alias")?.text ?? n.text.split(".")[0] }); }
      } else if (c.type === "import_list") {
        for (const item of named(c)) collect(item, names, modules);
      }
    };
    if (node.type === "import_statement" || node.type === "import_from_statement") {
      const names: Array<{ imported: string; local: string }> = [];
      const modules: string[] = [];
      for (const c of named(node)) collect(c, names, modules);
      return { module: modules[0] ?? null, names };
    }
    return null;
  }
  if (lang === "swift") {
    if (node.type !== "import_declaration") return null;
    const path = node.childForFieldName("path");
    const mod = path?.text ?? node.text.replace(/^import\s+(?:struct\s+|class\s+|func\s+|protocol\s+|typealias\s+|enum\s+)?/, "").trim();
    return { module: mod || null, names: [] };
  }
  return null;
}

function emitImportRefs(info: ImportInfo, line: number, refs: RefRecord[]): void {
  if (info.module) refs.push({ toName: info.module, kind: "import", line });
  for (const n of info.names) refs.push({ toName: n.imported, kind: "references", line });
}

/** cursor walk with a maintained parent chain */
function walkTree(tree: Tree, cb: (node: Node, parents: Array<{ type: string; name: string | null }>) => void): void {
  const cursor = tree.walk();
  const parents: Array<{ type: string; name: string | null }> = [];
  let reachedRoot = false;
  cb(cursor.currentNode, parents);
  while (!reachedRoot) {
    if (cursor.gotoFirstChild()) {
      parents.push({ type: cursor.currentNode.type, name: cursor.currentNode.childForFieldName("name")?.text ?? null });
      cb(cursor.currentNode, parents.slice(0, -1));
      continue;
    }
    if (cursor.gotoNextSibling()) {
      parents.pop();
      parents.push({ type: cursor.currentNode.type, name: cursor.currentNode.childForFieldName("name")?.text ?? null });
      cb(cursor.currentNode, parents.slice(0, -1));
      continue;
    }
    if (!cursor.gotoParent()) { reachedRoot = true; parents.pop(); continue; }
    parents.pop();
  }
}

/** extract symbols + refs from one source file. */
export async function extractFile(input: ExtractInput): Promise<Omit<FileRecord, "mtime"> | null> {
  const lang = detectLanguage(input.path);
  if (lang === "unknown") return null;
  const parser = await parserFor(lang, input.path);
  if (!parser) return null;
  const tree = parser.parse(input.content);
  if (!tree) return null;

  const source = input.content;
  const symbols: SymbolRecord[] = [];
  const refs: RefRecord[] = [];
  /** definition nodes already recorded, innermost last (for enclosing-symbol lookup) */
  const defs: Array<{ node: Node; index: number }> = [];

  walkTree(tree, (rawNode, parents) => {
    const node: Node = rawNode!;
    if (!node) return;
    const line = node.startPosition.row + 1;
    let fromSymbolIndex: number | undefined;
    for (let i = defs.length - 1; i >= 0; i--) {
      const d = defs[i].node;
      if (node.startIndex >= d.startIndex && node.endIndex <= d.endIndex) { fromSymbolIndex = defs[i].index; break; }
    }

    // ---------------- definitions ----------------
    let kind: SymbolKind | null = null;
    switch (lang) {
      case "typescript":
      case "javascript": {
        if (TS_DEF_NODES[node.type]) kind = TS_DEF_NODES[node.type];
        else if (node.type === "method_definition") kind = "method";
        break;
      }
      case "python":
        if (PY_DEF_NODES[node.type]) kind = PY_DEF_NODES[node.type];
        break;
      case "swift":
        if (SWIFT_DEF_NODES[node.type]) kind = SWIFT_DEF_NODES[node.type];
        break;
    }

    // TS/JS variable declarations: each named declarator is a symbol
    if ((lang === "typescript" || lang === "javascript") && (node.type === "lexical_declaration" || node.type === "variable_declaration")) {
      for (const decl of named(node).filter((c) => c.type === "variable_declarator")) {
        const dn = decl.childForFieldName("name");
        if (!dn || dn.type !== "identifier") continue;
        const value = decl.childForFieldName("value");
        const isFn = !!value && ["arrow_function", "function_expression", "generator_function"].includes(value.type);
        symbols.push({
          name: dn.text,
          qualifiedName: dn.text,
          kind: isFn ? "function" : "variable",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: firstLineOf(node, source),
          exported: isTsExported(node),
        });
      }
      // declarations still host refs (initialiser calls) — fall through below
    }

    if (kind) {
      let name = defName(node, lang);
      if (!name) return; // anonymous function expression etc.
      const prefix = containerPrefix(parents, lang);
      if (lang === "swift" && kind === "function" && prefix) { name = `${prefix}.${name}`; kind = "method"; }
      else if (lang === "python" && kind === "function" && prefix) { name = `${prefix}.${name}`; kind = "method"; }
      else if ((lang === "typescript" || lang === "javascript") && kind === "method" && prefix) name = `${prefix}.${name}`;

      const exported =
        lang === "python" ? node.parent?.type === "module" :
        lang === "swift" ? swiftIsPublic(node) :
        isTsExported(node);

      const index = symbols.length;
      symbols.push({
        name,
        qualifiedName: name,
        kind,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: signatureOf(node, source),
        exported,
      });
      defs.push({ node, index });
    }

    // ---------------- refs ----------------
    if (lang === "typescript" || lang === "javascript") {
      if (node.type === "call_expression" || node.type === "new_expression") {
        const target = node.type === "new_expression" ? node.childForFieldName("constructor") : node.childForFieldName("function");
        const cn = calleeName(target);
        if (cn) refs.push({ fromSymbolIndex, toName: cn, kind: "call", line });
      } else if (node.type === "class_heritage") {
        // TS heritage wraps extends_clause/implements_clause children; plain JS
        // heritage holds the parent identifier directly. The grammar types
        // disagree on which, so compare types as strings.
        for (const c of named(node)) {
          const t: string = c.type;
          if (t === "extends_clause") { const v = c.childForFieldName("value"); if (v) refs.push({ fromSymbolIndex, toName: v.text.split("<")[0], kind: "extends", line }); }
          else if (t === "implements_clause") for (const x of named(c)) if (x.text) refs.push({ fromSymbolIndex, toName: x.text.split("<")[0], kind: "implements", line });
          else if (t === "identifier") refs.push({ fromSymbolIndex, toName: c.text, kind: "extends", line });
        }
      } else if (node.type === "import_statement") {
        const info = parseImport(node, lang);
        if (info) emitImportRefs(info, line, refs);
      } else if (node.type === "export_statement" && node.childForFieldName("source")) {
        // re-export: `export { x as y } from "./o.js"` — the module is the import target
        refs.push({ toName: node.childForFieldName("source")!.text.replace(/^['"]|['"]$/g, ""), kind: "import", line });
      } else if (node.type === "identifier" || node.type === "type_identifier" || node.type === "property_identifier") {
        const parent = node.parent;
        if (!parent) return;
        if (["import_specifier", "export_specifier", "namespace_import", "required_parameter", "optional_parameter", "formal_parameters", "assignment_expression"].includes(parent.type)) return;
        if (parent.childForFieldName("name")?.id === node.id) return;
        if (parent.type === "variable_declarator" && parent.childForFieldName("name")?.id === node.id) return;
        if (parent.type === "call_expression" && parent.childForFieldName("function")?.id === node.id) return;
        if (parent.type === "new_expression" && parent.childForFieldName("constructor")?.id === node.id) return;
        if (node.type === "property_identifier") {
          if (parent.type !== "member_expression") return;
          const obj = parent.childForFieldName("object");
          if (!obj || obj.type === "this" || obj.type === "super") return;
        }
        refs.push({ fromSymbolIndex, toName: node.text, kind: "references", line });
      }
    } else if (lang === "python") {
      if (node.type === "call") {
        const cn = calleeName(node.childForFieldName("function"));
        if (cn) refs.push({ fromSymbolIndex, toName: cn, kind: "call", line });
      } else if (node.type === "class_definition") {
        for (const c of (node.childForFieldName("superclasses") ? named(node.childForFieldName("superclasses")!) : [])) {
          const base = c.type === "keyword_argument" ? c.childForFieldName("name")?.text : c.text;
          if (base) refs.push({ fromSymbolIndex, toName: base.split("[")[0], kind: "extends", line });
        }
      } else if (node.type === "import_statement" || node.type === "import_from_statement") {
        const info = parseImport(node, lang);
        if (info) emitImportRefs(info, line, refs);
      } else if (node.type === "decorated_definition") {
        for (const dec of named(node).filter((c) => c.type === "decorator")) {
          const inner = dec.child(0);
          const cn = calleeName(inner?.type === "call" ? inner.childForFieldName("function") : inner ?? null);
          if (cn && cn !== "route") refs.push({ fromSymbolIndex, toName: cn, kind: "references", line });
        }
      } else if (node.type === "identifier") {
        const parent = node.parent;
        if (!parent) return;
        if (["parameters", "typed_default_parameter", "default_parameter", "import_list", "dotted_name", "aliased_import", "keyword_argument"].includes(parent.type)) return;
        if (parent.childForFieldName("name")?.id === node.id) return;
        if (parent.type === "call" && parent.childForFieldName("function")?.id === node.id) return;
        if (parent.type === "assignment" && parent.childForFieldName("left")?.id === node.id) return;
        refs.push({ fromSymbolIndex, toName: node.text, kind: "references", line });
      } else if (node.type === "attribute") {
        const attr = node.childForFieldName("attribute");
        if (attr && node.parent?.type !== "call") refs.push({ fromSymbolIndex, toName: attr.text, kind: "references", line });
      }
    } else if (lang === "swift") {
      if (node.type === "call_expression") {
        const cn = calleeName(node.childForFieldName("callee"));
        if (cn) refs.push({ fromSymbolIndex, toName: cn, kind: "call", line });
      } else if (node.type === "inheritance_specifier") {
        const t = node.childForFieldName("inherits_from");
        if (t) refs.push({ fromSymbolIndex, toName: t.text.replace(/<.*>/, ""), kind: "extends", line });
      } else if (node.type === "import_declaration") {
        const info = parseImport(node, lang);
        if (info) emitImportRefs(info, line, refs);
      } else if (node.type === "simple_identifier") {
        const parent = node.parent;
        if (!parent) return;
        if (["user_type", "type_identifier", "pattern", "bound_identifier", "property_definition_pattern", "navigation_expression"].includes(parent.type)) return;
        if (parent.childForFieldName("name")?.id === node.id) return;
        if (parent.type === "call_expression" && parent.childForFieldName("callee")?.text === node.text) return;
        refs.push({ fromSymbolIndex, toName: node.text, kind: "references", line });
      } else if (node.type === "user_type") {
        const t = node.descendantsOfType("type_identifier")[0]?.text ?? node.child(0)?.text;
        if (t) refs.push({ fromSymbolIndex, toName: t, kind: "references", line });
      }
    }
  });

  tree.delete();
  return {
    path: input.path,
    language: lang,
    contentHash: sha256(input.content),
    size: input.size ?? Buffer.byteLength(input.content),
    symbols,
    refs,
  };
}
