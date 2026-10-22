/** cockpit-page/win — the grid: width units and their CSS. Nothing here computes a position; the browser lays the cards out.
 *  A container (the page root, a group body) is a CSS grid of 12 columns; a card spans st.w of them (3 4 6 8 9 12 = 1/4 1/3 1/2 2/3 3/4 full),
 *  in tree order, as tall as its content; the cards of one grid row share its height. */

/** The width steps in units of 12 columns; the page script mirrors them (WIN_UNITS in store.ts). */
export const WIN_STEPS = [3, 4, 6, 8, 9, 12] as const;
/** The least body widths a card type is bucketed into (data-mw): a card never gets fewer px than its bucket. */
export const WIN_MINW = [160, 240, 300, 360] as const;
/** Gap between cards and padding of a group body, px. */
export const WIN_GAP = 6;
/** Header height of a card, px. */
export const WIN_HEAD = 28;

/** The container-query rules that promote a card to the next wider step when its container is too narrow for its span:
 *  a card of N units and least width m needs container width >= (m + gap) * 12 / N - gap; below that it takes the next step up, and so on to the full width.
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
        out.push(`@container (width<${need(m, prev)}px){main.win .card[data-w="${n}"][data-mw="${m}"]{grid-column:span ${s}}}`);
        prev = s;
      }
    }
  }
  return out.join("\n");
}

/** winStepFor(contW, gap, minW, targetW) -> the width in units the user's drag to targetW px chooses: the step nearest to targetW whose width is at least minW
 *  (12 when none is). */
export const WIN_LAYOUT_JS = String.raw`var WIN_STEPS=[3,4,6,8,9,12];
/** A card may fall this many px under its least width: a 1 px rounding of the container must not forbid the step. */
var MINW_SLACK=2;
function winStepFor(contW,gap,minW,targetW){
 var i,best=12,bd=1e9,w,d;
 for(i=0;i<WIN_STEPS.length;i++){
  w=WIN_STEPS[i]*(contW+gap)/12-gap;
  if(WIN_STEPS[i]<12&&w+MINW_SLACK<minW)continue;
  d=Math.abs(w-targetW);
  if(d<bd){bd=d;best=WIN_STEPS[i]}
 }
 return best;
}
`;
