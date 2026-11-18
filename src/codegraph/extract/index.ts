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
  return node.namedChildren.filter((c): c is Node => c != null);
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

/** doc comment (/// or /** …) attached to a definition — searchable question text */
function docCommentOf(node: Node, source: string): string | undefined {
  let prev = node.previousSibling;
  // TS/JS definitions sit inside their export_statement wrapper
  if (!prev && node.parent?.type === "export_statement") prev = node.parent.previousSibling;
  if (!prev) return undefined;
  if (prev.type !== "comment") return undefined;
  const t = prev.text;
  if (!(t.startsWith("///") || t.startsWith("/**"))) return undefined;
  return t.replace(/\s+/g, " ").trim().slice(0, 500);
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

const ALL_CONTAINERS = new Set(Object.values(CONTAINERS).flatMap((c) => [...c]));

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
  return direct.type === "identifier" || direct.type === "type_identifier" || direct.type === "property_identifier" ? direct.text : null;
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

/** cursor walk with a maintained parent chain (cb gets the ancestors of node) */
function walkTree(tree: Tree, cb: (node: Node, parents: Array<{ type: string; name: string | null }>) => void): void {
  const cursor = tree.walk();
  const parents: Array<{ type: string; name: string | null }> = [];
  // the name is only ever read for container types, so skip the WASM calls for every other node
  const entry = () => {
    const n = cursor.currentNode;
    return { type: n.type, name: ALL_CONTAINERS.has(n.type) ? n.childForFieldName("name")?.text ?? null : null };
  };
  cb(cursor.currentNode, parents);
  let curEntry = entry();
  for (;;) {
    if (cursor.gotoFirstChild()) {
      // the node we leave becomes an ancestor
      parents.push(curEntry);
      cb(cursor.currentNode, parents);
      curEntry = entry();
      continue;
    }
    // leaf: move to the next sibling, climbing until one exists
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) return;
      parents.pop();
    }
    cb(cursor.currentNode, parents);
    curEntry = entry();
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
  const defs: Array<{ end: number; index: number }> = [];

  // ---- local bindings per symbol -------------------------------------------
  // A function's parameters and its own locals are not callees: refs to them
  // stay unresolved and never resolve to a repo symbol (resolve.ts matches by
  // name), so they pollute `pai code callees`. Record every binding site per
  // enclosing definition; the ref pass skips refs whose target is bound there.
  /** local names of the innermost definition containing a node, null at file level */
  const localsOf = new Map<number, Set<string>>();
  /** definitions still open at the current node (walk order is document order) */
  const openDefs: Array<{ end: number; id: number }> = [];
  const enclosingAt = (start: number): number => {
    while (openDefs.length && openDefs[openDefs.length - 1].end <= start) openDefs.pop();
    return openDefs.length ? openDefs[openDefs.length - 1].id : -1;
  };
  const addLocal = (start: number, name: string): void => {
    const id = enclosingAt(start);
    if (id < 0) return; // file-level bindings are repo symbols themselves
    let set = localsOf.get(id);
    if (!set) { set = new Set(); localsOf.set(id, set); }
    set.add(name);
  };

  walkTree(tree, (rawNode, parents) => {
    const node: Node = rawNode!;
    if (!node) return;
    const line = node.startPosition.row + 1;
    // walk order is document order: pop definitions this node has moved past
    const nodeStart = node.startIndex;
    enclosingAt(nodeStart); // also advances the enclosing-definition cursor for localsOf

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
        const index = symbols.length;
        symbols.push({
          name: dn.text,
          qualifiedName: dn.text,
          kind: isFn ? "function" : "variable",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: firstLineOf(node, source),
          doc: docCommentOf(node, source),
          exported: isTsExported(node),
        });
        openDefs.push({ end: node.endIndex, id: index });
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
        doc: docCommentOf(node, source),
        exported,
      });
      openDefs.push({ end: node.endIndex, id: index });
    }

    // ---------------- local bindings ----------------
    // parameters and let/const/var declarations bind names inside their
    // enclosing definition; refs to bound names are not calls of repo symbols.
    if (lang === "typescript" || lang === "javascript") {
      if (node.type === "formal_parameters") {
        for (const p of named(node)) {
          const pn = p.type === "required_parameter" || p.type === "optional_parameter" ? p.childForFieldName("pattern") : p;
          if (!pn) continue;
          if (pn.type === "identifier") addLocal(pn.startIndex, pn.text);
          else for (const id of pn.descendantsOfType("identifier")) addLocal(id.startIndex, id.text);
        }
      } else if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
        for (const decl of named(node).filter((c) => c.type === "variable_declarator")) {
          const dn = decl.childForFieldName("name");
          if (!dn) continue;
          if (dn.type === "identifier") addLocal(dn.startIndex, dn.text);
          else for (const id of dn.descendantsOfType("identifier")) addLocal(id.startIndex, id.text);
        }
      }
    } else if (lang === "python") {
      if (node.type === "parameters") {
        for (const c of named(node)) {
          const pn = c.type === "typed_parameter" || c.type === "typed_default_parameter" || c.type === "default_parameter" ? c.childForFieldName("name") : c;
          const id = pn && (pn.type === "identifier" ? pn : pn?.descendantsOfType("identifier")[0]);
          if (id) addLocal(id.startIndex, id.text);
        }
      } else if (node.type === "assignment") {
        const left = node.childForFieldName("left");
        if (left && ["identifier", "pattern_list", "tuple_pattern", "list_pattern"].includes(left.type)) {
          for (const id of left.type === "identifier" ? [left] : left.descendantsOfType("identifier")) addLocal(id.startIndex, id.text);
        }
      }
    } else if (lang === "swift") {
      if (node.type === "function_value_parameters") {
        for (const vp of named(node).filter((c) => c.type === "parameter")) {
          const id = vp.descendantsOfType("simple_identifier").pop();
          if (id) addLocal(id.startIndex, id.text);
        }
      } else if (node.type === "property_declaration" && enclosingAt(node.startIndex) >= 0) {
        // a local let/var inside a function body (top-level ones are symbols)
        const pat = node.childForFieldName("pattern") ?? node.descendantsOfType("pattern")[0];
        const id = pat?.descendantsOfType("simple_identifier").pop();
        if (id) addLocal(id.startIndex, id.text);
      }
    }

    // ---------------- refs ----------------
    /** true when the ref target is a parameter or local of the enclosing definition */
    const isLocalTarget = (toName: string): boolean => {
      const id = enclosingAt(nodeStart);
      return id >= 0 && localsOf.get(id)?.has(toName) === true;
    };
    if (lang === "typescript" || lang === "javascript") {
      if (node.type === "call_expression" || node.type === "new_expression") {
        const target = node.type === "new_expression" ? node.childForFieldName("constructor") : node.childForFieldName("function");
        const cn = calleeName(target);
        if (cn && !isLocalTarget(cn)) refs.push({ fromSymbolIndex, toName: cn, kind: "call", line });
      } else if (node.type === "class_heritage") {
        // TS heritage wraps extends_clause/implements_clause children; plain JS
        // heritage holds the parent identifier directly. The grammar types
        // disagree on which, so compare types as strings.
        for (const c of named(node)) {
          const t: string = c.type;
          if (t === "extends_clause") { const v = c.childForFieldName("value"); if (v) refs.push({ fromSymbolIndex, toName: v.text.split("<")[0], kind: "extends", line }); }
          else if (t === "implements_clause") { for (const x of named(c)) if (x.text) refs.push({ fromSymbolIndex, toName: x.text.split("<")[0], kind: "implements", line }); }
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
        if (!isLocalTarget(node.text)) refs.push({ fromSymbolIndex, toName: node.text, kind: "references", line });
      }
    } else if (lang === "python") {
      if (node.type === "call") {
        const cn = calleeName(node.childForFieldName("function"));
        if (cn && !isLocalTarget(cn)) refs.push({ fromSymbolIndex, toName: cn, kind: "call", line });
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
        if (!isLocalTarget(node.text)) refs.push({ fromSymbolIndex, toName: node.text, kind: "references", line });
      } else if (node.type === "attribute") {
        const attr = node.childForFieldName("attribute");
        if (attr && node.parent?.type !== "call" && !isLocalTarget(attr.text)) refs.push({ fromSymbolIndex, toName: attr.text, kind: "references", line });
      }
    } else if (lang === "swift") {
      if (node.type === "call_expression") {
        const cn = calleeName(node.childForFieldName("callee"));
        if (cn && !isLocalTarget(cn)) refs.push({ fromSymbolIndex, toName: cn, kind: "call", line });
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
        if (!isLocalTarget(node.text)) refs.push({ fromSymbolIndex, toName: node.text, kind: "references", line });
      } else if (node.type === "user_type") {
        const t = node.descendantsOfType("type_identifier")[0]?.text ?? node.child(0)?.text;
        if (t && !isLocalTarget(t)) refs.push({ fromSymbolIndex, toName: t, kind: "references", line });
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
