/**
 * Snapshot builder — the single source of truth for the a11y-tree YAML that
 * dom_snapshot returns. Pure functions, no chrome.* access, imported by
 * background.js AND by vitest.
 *
 * Input: a distilled CDP DOM tree (see distill() in background.js):
 *   { nodeId, nodeName, nodeType, attrs: {...}, children: [...] }
 *   attrs keys: role, aria-label, name, id, placeholder, href, type, value,
 *   text, tabindex, click  (all optional; absent = not set)
 *
 * Output:
 *   yaml   — one line per rendered element, 2-space indent per depth
 *   refMap — { "s1": <CDP nodeId>, ... } for the refs emitted in this yaml
 *
 * Refs are per-snapshot: a fresh buildSnapshot() starts the counter at s1
 * again. They stay valid only until the next snapshot or navigation on that
 * tab; resolving a ref afterwards is background.js's problem (error).
 */

const INTERACTIVE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "tab",
  "menuitem",
  "option",
  "slider",
  "switch",
  "searchbox",
  "listbox",
  "spinbutton",
  "treeitem",
  "progressbar",
  "scrollbar",
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const TEXTBOX_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);

/** Maps an input[type=...] to its a11y role. */
function inputRole(type) {
  const t = String(type || "").toLowerCase();
  if (TEXTBOX_INPUT_TYPES.has(t)) return "textbox";
  if (t === "checkbox") return "checkbox";
  if (t === "radio") return "radio";
  if (t === "range") return "slider";
  if (t === "button" || t === "submit" || t === "reset") return "button";
  return "textbox";
}

/** A11y role for a distilled node, honouring an explicit role attribute. */
function roleOf(node) {
  const attrs = node.attrs || {};
  if (attrs.role) return String(attrs.role).toLowerCase();
  const tag = String(node.nodeName || "").toLowerCase();
  if (tag === "#document" || node.nodeType === 9) return "document";
  if (tag === "a") return "link";
  if (HEADING_TAGS.has(tag)) return "heading";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "option") return "option";
  if (tag === "textarea") return "textbox";
  if (tag === "input") return inputRole(attrs.type);
  if (tag === "img") return "img";
  return "generic";
}

/**
 * Interactive = one of the widget roles, or an explicit role=, or a tabindex,
 * or distilled click semantics (onclick/handlers). Only interactive elements
 * get a [ref=sN].
 */
function isInteractive(node, role) {
  if (INTERACTIVE_ROLES.has(role)) return true;
  const attrs = node.attrs || {};
  if (attrs.role !== undefined && attrs.role !== "") return true;
  if (attrs.tabindex !== undefined && attrs.tabindex !== null && attrs.tabindex !== "") return true;
  if (attrs.click) return true;
  return false;
}

/** Collapses whitespace and truncates; double quotes are escaped. */
function cleanName(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  const capped = s.length > 200 ? s.slice(0, 200) + "…" : s;
  return capped.replace(/"/g, '\\"');
}

/**
 * Accessible name: aria-label, then a distilled computed name, then
 * placeholder / current value for inputs, then own text content.
 */
function accessibleName(node) {
  const attrs = node.attrs || {};
  const ownText = (node.children || [])
    .filter((c) => c.nodeType === 3)
    .map((c) => c.attrs?.text || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const ariaLabel = attrs["aria-label"] ?? attrs.ariaLabel;
  if (ariaLabel) return cleanName(ariaLabel);
  if (attrs.name) return cleanName(attrs.name);
  if (attrs.placeholder) return cleanName(attrs.placeholder);
  if (attrs.value !== undefined && attrs.value !== null && String(attrs.value) !== "" &&
      String(node.nodeName).toLowerCase() === "input") {
    return cleanName(attrs.value);
  }
  if (attrs.text) return cleanName(attrs.text);
  return cleanName(ownText);
}

/**
 * Builds the snapshot YAML and its ref map.
 *
 * @param {object} domNodeTree distilled DOM tree (see module doc)
 * @returns {{ yaml: string, refMap: Record<string, number> }}
 */
export function buildSnapshot(domNodeTree) {
  const refMap = {};
  let counter = 0;
  const lines = [];

  const render = (node, depth) => {
    if (!node || node.nodeType === 3) return; // text is folded into names
    const attrs = node.attrs || {};
    const role = roleOf(node);
    const interactive = isInteractive(node, role);

    // Transparent containers: no line of their own, children move up.
    if (role === "generic" && !interactive && !accessibleName(node)) {
      for (const child of node.children || []) render(child, depth);
      return;
    }

    const name = accessibleName(node);
    const parts = [];
    let label;
    if (role === "document") {
      label = `- document "${name}":`;
    } else if (role === "heading") {
      const level = Number(attrs.level) || Number(String(node.nodeName || "").slice(1)) || 1;
      parts.push(`level=${level}`);
      label = `- heading "${name}"`;
    } else if (role === "generic") {
      label = `- text "${name}"`;
    } else {
      label = `- ${role} "${name}"`;
    }
    if (interactive) {
      const ref = `s${++counter}`;
      refMap[ref] = node.nodeId;
      parts.push(`ref=${ref}`);
    }
    lines.push("  ".repeat(depth) + label + (parts.length ? ` [${parts.join(" ")}]` : ""));
    for (const child of node.children || []) render(child, depth + 1);
  };

  render(domNodeTree, 0);
  return { yaml: lines.join("\n"), refMap };
}
