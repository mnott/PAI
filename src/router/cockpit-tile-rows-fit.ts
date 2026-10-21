/**
 * Shared fixture for the .rt-tiles last-row fit check: a container query host with a
 * .rt-tiles grid of N metric tiles, measured in headless Chromium. The page HTML is
 * rendered with a temp config (never the live files) so the layout constants are known
 * in the test: C = tilesWideCols, T = 3*C tracks, breakpoints as configured.
 */

export interface TileLayout {
  wideBreakpointPx: number;
  oneColBreakpointPx: number;
  wideCols: number;
  narrowCols: number;
}
export interface TileRect { x: number; w: number }
export interface TileRow { y: number; rects: TileRect[] }
export interface TileMeasure { gridW: number; rows: TileRow[] }

/** One .rt-tiles grid with n metric tiles inside a container query host of the given width. */
export function tileFixtureHtml(n: number, containerPx: number, cls = "rt-tiles"): string {
  const tiles = Array.from({ length: n }, (_, i) => `<div class="mt"><div class="mt-label">t${i}</div><div class="mt-value">${i}</div></div>`).join("");
  return `<!doctype html><html><body style="margin:0">
<div style="width:${containerPx}px;container-type:inline-size"><div class="${cls}">${tiles}</div></div>
<script>setTimeout(function(){
var g=document.querySelector(".rt-tiles");var gr=g.getBoundingClientRect();
var rows={};
g.querySelectorAll(".mt").forEach(function(t){var r=t.getBoundingClientRect();var y=Math.round(r.top);(rows[y]=rows[y]||[]).push({x:r.left-gr.left,w:r.width})});
parent.postMessage(JSON.stringify({gridW:gr.width,rows:Object.keys(rows).sort(function(a,b){return a-b}).map(function(y){return{y:+y,rects:rows[y]}})}),"*");
},300)</script></body></html>`;
}

/** Group tile rects into rows by y, then check every row fills the grid width. */
export function checkRows(m: TileMeasure, label: string): string[] {
  const fails: string[] = [];
  for (const row of m.rows) {
    const right = Math.max(...row.rects.map((r) => r.x + r.w));
    if (right > m.gridW + 2) fails.push(`${label} row@${row.y}: tiles reach ${right.toFixed(1)}px in a ${m.gridW.toFixed(1)}px grid`);
    if (m.gridW - right > 2) fails.push(`${label} row@${row.y}: tiles stop at ${right.toFixed(1)}px of ${m.gridW.toFixed(1)}px — empty space left`);
    if (row.rects.length === 1 && row.rects[0].w < m.gridW - 2) fails.push(`${label} row@${row.y}: one narrow tile (${row.rects[0].w.toFixed(1)}px) beside empty space`);
  }
  return fails;
}
