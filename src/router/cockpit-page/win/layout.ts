/** cockpit-page/win — the grid: width units and their CSS. Nothing here computes a position; the browser lays the cards out.
 *  A container (the page root, a group body) is a CSS grid of 12 columns; a card spans st.w of them (3 4 6 8 9 12 = 1/4 1/3 1/2 2/3 3/4 full),
 *  in tree order, as tall as its content; the cards of one grid row share its height. */

/** The widths a card may hold in units of 12 columns (WIN_UNITS in store.ts mirrors them): 2 only by default (six KPIs in a row), the handle steps through 3 4 6 8 9 12. */
export const WIN_STEPS = [2, 3, 4, 6, 8, 9, 12] as const;
/** The least body widths a card type is bucketed into (data-mw): a card never gets fewer px than its bucket. */
export const WIN_MINW = [100, 120, 160, 200, 240, 300, 360] as const;
/** The least width a top-level section keeps at its stored share, px (below it the section spans the full row). */
export const WIN_SECTION_MINW = 420;
/** Gap between cards and padding of a group body, px. */
export const WIN_GAP = 6;
/** Header height of a card, px. */
export const WIN_HEAD = 28;

/** The container-query rules that promote a card to the next wider step when its container is too narrow for its span:
 *  a card of N units and least width m needs container width >= (m + gap) * 12 / N - gap; below that it takes the next step up, and so on to the full width
 *  (2 units go straight to 4: six cards in a row become two lines of three).
 *  Pure CSS: no script measures anything. */
export function winGridCss(gap: number = WIN_GAP): string {
  const need = (m: number, n: number): number => Math.ceil(((m + gap) * 12) / n - gap);
  const out: string[] = [];
  for (const m of WIN_MINW) {
    for (let i = 0; i < WIN_STEPS.length - 1; i++) {
      const n = WIN_STEPS[i];
      let prev = n;
      for (let j = i + 1; j < WIN_STEPS.length; j++) {
        const s = WIN_STEPS[j];
        if (n === 2 && s === 3) continue; // six cards of 2 units go 6, 3, 2 per line (balanced), not 6, 4, 3
        out.push(`@container (width<${need(m, prev)}px){main.win .card[data-w="${n}"][data-mw="${m}"]{grid-column:span ${s}}}`);
        prev = s;
      }
    }
  }
  // a top-level section is wider than its bucket: under WIN_SECTION_MINW at its stored share it takes the full row (the stored width stays; widening restores it)
  for (const n of WIN_STEPS.slice(0, -1)) out.push(`@container (width<${need(WIN_SECTION_MINW, n)}px){main.win .card[data-depth="0"][data-w="${n}"][data-mw]{grid-column:span 12}}`);
  return out.join("\n");
}

/** winStepFor(contW, gap, minW, targetW) -> the width in units the user's drag to targetW px chooses: the step nearest to targetW whose width is at least minW
 *  (12 when none is). */
export const WIN_LAYOUT_JS = String.raw`var WIN_HANDLE=[3,4,6,8,9,12];
/** A card may fall this many px under its least width: a 1 px rounding of the container must not forbid the step. */
var MINW_SLACK=2;
function winStepFor(contW,gap,minW,targetW){
 var i,best=12,bd=1e9,w,d;
 for(i=0;i<WIN_HANDLE.length;i++){
  w=WIN_HANDLE[i]*(contW+gap)/12-gap;
  if(WIN_HANDLE[i]<12&&w+MINW_SLACK<minW)continue;
  d=Math.abs(w-targetW);
  if(d<bd){bd=d;best=WIN_HANDLE[i]}
 }
 return best;
}
`;
