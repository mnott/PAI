/** Test helper: cuts named top-level functions and `var` lines out of the generated page script so a test can run them in node. */

/** The source of `function name(...)`: one line when it closes on it, else up to the closing `}` at column 0. */
export function fnSrc(html: string, name: string): string {
  const m = new RegExp(`^function ${name}\\([^\\n]*`, "m").exec(html);
  if (!m) throw new Error(`function ${name} not in the page`);
  if (m[0].endsWith("}")) return m[0];
  const end = html.indexOf("\n}", m.index);
  return html.slice(m.index, end + 2);
}

/** The whole line of `var name=...` at column 0 (may declare more names after a comma). */
export function varSrc(html: string, name: string): string {
  const m = new RegExp(`^var [^\\n]*?\\b${name}=[^\\n]*`, "m").exec(html);
  if (!m) throw new Error(`var ${name} not in the page`);
  return m[0];
}

/** The hide-rule helpers of the page (script-hide.ts) a table renderer needs: their functions and state vars, for a node harness. */
export function hideLib(html: string): string {
  const fns = ["hideRe", "hideRuleHits", "hideText", "hideIs", "hideShown", "hideFilter", "hideSuggest", "hideBtn", "hideRedraw", "hidePost", "hideHeadAction", "hidePaintHeads", "hideNote", "hideLists", "hidePanelHtml", "hideWire"];
  return [varSrc(html, "HIDE_LISTS"), varSrc(html, "HIDE_P"), varSrc(html, "HIDE_TXT"), ...fns.map((n) => fnSrc(html, n))].join("\n");
}
