/** cockpit-page — the page stylesheet (between the style tags). */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** All CSS rules. */
export const css = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--dim:#6b7385;--line:#e3e6ec;--ok:#2e9e5b;--warn:#d98a1c;--bad:#d64545;--acc:#3b6fe0}
:root[data-theme=dark]{--bg:#10131a;--card:#181c26;--fg:#e4e8f1;--dim:#8b93a7;--line:#2a3040;--ok:#46c47a;--warn:#e8a43a;--bad:#ef6b6b;--acc:#6b95f5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
header{flex-wrap:wrap;display:flex;align-items:center;gap:16px;padding:8px 14px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
h1{font-size:15px;margin:0;font-weight:600}h2{font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600}
.card.folded>div{display:none}.fold{background:none;border:0;padding:0 4px;color:var(--dim);cursor:pointer;font:inherit;line-height:1}.fold:hover{color:var(--acc)}.fold .chev{display:inline-block;width:12px}
.tabs button{background:var(--card);color:var(--fg);border:1px solid var(--line);padding:3px 12px;cursor:pointer;font:inherit}
.tabs button:first-child{border-radius:6px 0 0 6px}.tabs button:last-child{border-radius:0 6px 6px 0}
.tabs button.on{background:var(--acc);border-color:var(--acc);color:#fff}
#stamp{margin-left:auto;color:var(--dim)}#stamp.stale{color:var(--bad)}
@media(max-width:480px){header{flex-wrap:nowrap;gap:8px;padding:8px 10px}h1{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}.tabs{flex:0 0 auto}.tabs button{padding:3px 8px}#stamp{display:none}#reset{flex:0 0 auto;margin-left:auto}#theme{flex:0 0 auto}}
#theme{background:none;border:0;padding:2px;color:var(--dim);cursor:pointer;line-height:0;border-radius:50%}#theme:hover{color:var(--acc)}
#reset{background:none;border:0;padding:2px 4px;color:var(--dim);cursor:pointer;font-size:15px;line-height:1;border-radius:6px}#reset:hover{color:var(--acc)}
:root[data-theme=dark] .ic-moon{display:none}:root:not([data-theme=dark]) .ic-sun{display:none}
main{padding:10px 14px;display:grid;gap:10px;grid-template-columns:repeat(${L.gridCols},minmax(0,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0;overflow-wrap:anywhere}
.gauge .s{overflow-wrap:anywhere}
.c12{grid-column:span ${L.gridCols}}.c8{grid-column:span 8}.c6{grid-column:span 6}.c4{grid-column:span 4}
@media(max-width:${L.gridBreakpointPx}px){.c8,.c6,.c4{grid-column:span ${L.gridCols}}}
/* narrow main: a row of n sections stacks only when main width / n is under minSectionPx
 * (the JS toggles this class per section from the live main width via ResizeObserver, not a media query) */
section[data-section].stacked{grid-column:span ${L.gridCols}!important}
.gauges{display:flex;flex-wrap:wrap;gap:10px 14px;min-width:0}.gauge{text-align:center;min-width:0;flex:1 1 ${L.gaugeMinWidthPx}px;max-width:min(${L.gaugeMaxWidthPx}px,100%);overflow:hidden}.gauge .n,.gauge .s{overflow-wrap:anywhere}
.ltile .phead{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.lname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.nw{white-space:nowrap}.ltab{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 12px;font-size:12px;text-align:left}.ltab .nw{overflow:hidden;text-overflow:ellipsis}
.pgroup{border:1px solid var(--line);border-radius:8px;padding:6px 10px;min-width:0;margin:4px 0}.phead{font-weight:600;font-size:12px;margin-bottom:4px}
.gauge svg{display:block;width:100%;height:auto}
.gauge .n{font-weight:600}.gauge .s{color:var(--dim);font-size:12px}
.tw{max-width:100%}
/* auto layout: a column is never squeezed under its min-content (a nowrap header or
 * number keeps its full word); the text columns (.txt) shrink to 0 and absorb the squeeze */
table{border-collapse:collapse;width:100%}
/* headers and numbers never break: nowrap, no overflow-wrap; the text columns (.txt) absorb the squeeze */
th,td{text-align:right;padding:2px 4px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw td button{padding:0 3px;font-size:11px;margin:1px 0}
td.txt,th.txt{min-width:10ch;width:0}
td.txt{white-space:normal;overflow-wrap:anywhere}
/* the non-.txt columns shrink to their content, so the first .txt column takes the free width */
th:not(.txt),td:not(.txt){width:1%}
.cell2 .l1,.cell2 .l2{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
th{color:var(--dim);font-weight:500}th:first-child,td:first-child{text-align:left}
/* a table never scrolls sideways: fixed layout, headers and numbers on one line,
 * text cells wrap or ellipsise with the full text in the cell's title */
/* a table stacks into cards only when it does not fit as a table: the script measures the
 * unstacked layout (fitTables) and sets .stacked on the .tw; a row is then label: value pairs */
.tw.stacked table{display:block}
.tw.stacked thead,.tw.stacked tbody{display:block;width:auto;max-width:100%;min-width:0}
.tw.stacked tr{display:block;width:auto;max-width:100%;min-width:0;border-bottom:1px solid var(--line);padding:4px 0}
.tw.stacked thead{display:none}
.tw.stacked th,.tw.stacked td{display:flex;justify-content:space-between;gap:10px;border-bottom:0;text-align:left;white-space:normal;position:static;width:auto;max-width:100%;min-width:0}
.tw.stacked td::before{content:attr(data-l);color:var(--dim);font-weight:500;white-space:nowrap;flex:none;align-self:flex-start}
/* inline column caps (width, max-width, nowrap) give way to the card */
.tw.stacked td{width:auto!important;max-width:100%!important;white-space:normal!important}
.tw.stacked td>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.bar{display:inline-block;height:8px;border-radius:3px;background:var(--ok);vertical-align:middle}
.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--ok)}.dim{color:var(--dim)}
.kpis{display:flex;gap:8px 20px;flex-wrap:wrap}.kpi b{font-size:20px;display:block;font-weight:600}.kpi span{color:var(--dim)}
.chips.lowmodels{margin-top:6px}.pgrid{display:flex;flex-wrap:wrap;gap:8px;min-width:0;align-items:start}.pgrid>*{flex:1 1 ${L.providerTileMinPx}px;min-width:min(${L.providerTileMinPx}px,100%)}.pgrid .downs{flex-basis:100%}.pgrid .pgroup{margin:0}.pgsub{margin-top:10px}.rtrow{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:4px 0;border-top:1px solid var(--line)}.rtrow:first-child{border-top:0}.rtlabel{min-width:96px;font-weight:600}.rtchips{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;min-width:0}.rtarrow{color:var(--dim)}.rtchip{display:inline-flex;gap:6px;align-items:center;padding:1px 10px;border-radius:12px;border:1px solid var(--line);font-size:12px;white-space:nowrap}.rtflow{font-weight:600;padding:2px 0 6px}.rtchip.available{background:color-mix(in srgb,var(--ok) 22%,var(--card));border-color:var(--ok)}.rtchip.tight{background:color-mix(in srgb,var(--warn) 25%,var(--card));border-color:var(--warn)}.rtchip.idle{background:var(--bg);color:var(--dim)}.rtchip.unavailable{background:color-mix(in srgb,var(--bad) 22%,var(--card));border-color:var(--bad)}
.ctl{display:flex;gap:10px;align-items:center;margin-bottom:6px;flex-wrap:wrap}.ctl button,.ctl select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 10px;font:inherit;cursor:pointer}.ctl button.on{background:var(--acc);border-color:var(--acc);color:#fff}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;color:var(--dim);font-size:12px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.lgline{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;width:100%}
.lgcap{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.cap{margin-top:4px;font-size:11px}
.rings{display:grid;grid-template-columns:repeat(auto-fill,minmax(${L.ringMinWidthPx}px,1fr));gap:6px}.ring{text-align:center;min-width:0}.ring .n,.ring .s{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ring .n{font-weight:600}.ring .s{color:var(--dim);font-size:11px}.ring.low{opacity:.45}.rings h4{grid-column:1/-1;margin:0;font-size:11px;font-weight:400;color:var(--dim)}
.rings .solo{grid-column:1/-1;display:flex;align-items:center;justify-content:center;gap:16px;width:100%;flex-wrap:wrap}.bignum{font-size:26px;font-weight:600;text-align:center}.bignum span{display:block;font-size:11px;color:var(--dim);font-weight:400}
svg text{fill:var(--dim);font-size:10px}
.tip{position:relative;display:inline-block;margin-left:5px;width:14px;height:14px;line-height:14px;text-align:center;font:11px/14px inherit;font-style:normal;text-transform:none;letter-spacing:0;color:var(--dim);cursor:help;border-radius:50%;vertical-align:middle}
.tip:hover,.tip:focus{color:var(--acc);outline:none}
.tip::after{content:attr(data-tip);display:none;position:absolute;z-index:5;top:18px;left:-6px;width:max-content;max-width:min(340px,72vw);padding:6px 9px;background:var(--fg);color:var(--bg);border-radius:6px;font-size:12px;font-weight:400;line-height:1.4;white-space:pre-line;text-align:left;text-transform:none;letter-spacing:0;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.tip:hover::after,.tip:focus::after{display:block}
.downs{width:100%;color:var(--dim)}.downs summary{cursor:pointer}.downs .chip{margin:2px 2px 0 0}.chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}.chip{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:0 8px;font-size:12px;white-space:nowrap}.chip b{font-weight:600}.grip{cursor:grab;color:var(--dim)}tr.qrow{cursor:grab}
#sessions td:first-child{min-width:0}#sessions td:first-child span[title]{display:inline-block;max-width:min(${L.sessionTitleMaxWidthPx}px,100%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.mt{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%;overflow:hidden}
.mt-label{display:flex;align-items:center;gap:6px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}
.mt{position:relative}.tgrip{position:absolute;top:4px;right:6px;opacity:0;transition:opacity .12s;cursor:grab;color:var(--dim);font-size:11px;line-height:1;user-select:none;-webkit-user-select:none;touch-action:none}
.mt:hover .tgrip,.tgrip:focus-visible{opacity:.6}@media(hover:none){.tgrip{opacity:.5}}
.sgrip{background:none;border:0;padding:0 4px 0 0;color:var(--dim);cursor:grab;font:inherit;line-height:1;user-select:none;-webkit-user-select:none;touch-action:none}.sgrip:hover{color:var(--acc)}.sgrip:focus-visible{outline:2px solid var(--acc);border-radius:4px}
.dropind{position:fixed;z-index:9;pointer-events:none;border:2px solid var(--acc);border-radius:8px;background:color-mix(in srgb,var(--acc) 12%,transparent)}
.dropind[data-mode=above]{border-top-width:6px}.dropind[data-mode=below]{border-bottom-width:6px}.dropind[data-mode=left]{border-left-width:6px}.dropind[data-mode=right]{border-right-width:6px}
.dropind.bad{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent)}
.mt-values{display:flex;justify-content:space-between;gap:10px}.mt-values>div{display:flex;flex-direction:column;gap:2px;min-width:0}.mt-sec{text-align:right}
.mt-values{flex-wrap:nowrap}
.mt-value{font-size:clamp(18px,2.2vw,26px);font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums;white-space:nowrap}.mt-value small{font-size:12px;font-weight:500;color:var(--dim);margin-left:4px}
.mt-sub{font-size:11px;color:var(--dim);min-height:1em;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-fill{display:flex;align-items:center;gap:6px;min-width:0}.mt-bar{flex:0 0 40%;height:4px;border-radius:2px;background:var(--line);overflow:hidden}.mt-bar i{display:block;height:100%;background:var(--acc)}.mt-fill .mt-sub{flex:1 1 auto;min-width:0}
.mt-spark{display:block;width:100%;max-width:100%;height:${L.sparkHeightPx}px;margin-top:auto;overflow:visible;color:var(--acc)}.mt-spark .mt-alt{color:var(--warn);stroke:var(--warn)}.mt-spark .mt-warn{stroke:var(--warn)}.mt-spark .mt-ok{stroke:var(--ok)}.mt-spark .mt-bad{stroke:var(--bad)}
.rt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(${L.runtimeCardMinPx}px,100%),1fr));gap:8px;min-width:0;align-items:stretch}
.rt-card{container-type:inline-size;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%;overflow:hidden}
.rt-head{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:nowrap}
.rt-head b{font-size:14px;font-weight:600;min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-head .badge{flex:0 0 auto}
.rt-sub{color:var(--dim);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-dot{width:9px;height:9px;border-radius:50%;background:var(--ok);flex:0 0 auto}
.rt-dot.idle{background:transparent;box-shadow:inset 0 0 0 2px var(--ok)}
.rt-dot.down{background:var(--bad)}
/* foldable model cards: the header line toggles the body; folded cards show header only */
.mcard{container-type:inline-size;background:var(--card);border:1px solid var(--line);border-radius:8px;min-width:0;max-width:100%;overflow:hidden}
.mhead{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:nowrap;width:100%;background:none;border:0;border-bottom:1px solid transparent;padding:7px 10px;color:var(--fg);cursor:pointer;font:inherit;text-align:left}
.mhead:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}
.mcard.open .mhead{border-bottom-color:var(--line)}
.mhead:hover{color:var(--acc)}
.mhead b{font-size:13px;font-weight:600;min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mhead .mid{flex:0 1 auto;min-width:0;color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mhead .chev{flex:0 0 auto;width:12px;color:var(--dim)}
.mhead .num{margin-left:auto;flex:0 0 auto;color:var(--dim);font-size:12px;white-space:nowrap}
.mhead .badge{flex:0 0 auto}
.mbody{padding:8px 10px;display:none;flex-direction:column;gap:8px;min-width:0}
.mcard.open .mbody{display:flex}
.mcard.down{border-color:var(--bad)}
.mdown{color:var(--bad);font-size:12px}
/* start/stop sit right-aligned in the header; the memory/count text (.num) is a separate element */
.mhead .act{flex:0 0 auto;margin-left:auto}
.mhead .num{margin-left:8px}
@container (max-width:480px){.mhead{flex-wrap:wrap;row-gap:3px}.mhead b{flex:0 1 auto;max-width:calc(100% - 76px)}.mhead .lblbtn{margin-right:auto}.mhead .mid{flex-basis:100%;order:1}.mhead .badge,.mhead .act,.mhead .num{order:2}}
.mhead .act button{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:1px 8px;font:inherit;font-size:11px;cursor:pointer}
.mhead .act button:hover{border-color:var(--acc);color:var(--acc)}
.mhead .act button[disabled]{opacity:.5;cursor:default}
.mhead .msg{color:var(--dim);font-size:11px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mhead .msg.bad{color:var(--bad)}
.badge{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:0 8px;font-size:11px;color:var(--dim);white-space:nowrap}
/* never a partial last row: wide mode is a ${L.tilesWideCols * 3}-track grid, every tile spans
 * ${L.tilesWideCols === 4 ? 3 : L.tilesWideCols} tracks, and the last row's remainder 1/2/3 tiles
 * widen to fill it (the nth-child rules assume ${L.tilesWideCols} tiles per row). The odd-last-tile
 * rule belongs to 2-column mode only, so it never fights the remainder rules in wide mode. */
.rt-tiles{display:grid;grid-template-columns:repeat(${L.tilesNarrowCols},minmax(0,1fr));gap:8px;min-width:0}
.rt-tiles.two .mt:last-child:nth-child(odd){grid-column:1/-1}
@container (max-width:${L.tilesWideBreakpointPx - 1}px){.rt-tiles .mt:last-child:nth-child(odd){grid-column:1/-1}}
@container (min-width:${L.tilesWideBreakpointPx}px){.rt-tiles:not(.two){grid-template-columns:repeat(${L.tilesWideCols * 3},minmax(0,1fr))}.rt-tiles:not(.two) .mt{grid-column:span ${L.tilesWideCols === 4 ? 3 : L.tilesWideCols}}.rt-tiles:not(.two) .mt:last-child:nth-child(${L.tilesWideCols}n+1){grid-column:1/-1}.rt-tiles:not(.two) .mt:nth-last-child(2):nth-child(${L.tilesWideCols}n+1),.rt-tiles:not(.two) .mt:nth-last-child(2):nth-child(${L.tilesWideCols}n+1) ~ .mt{grid-column:span ${Math.floor((L.tilesWideCols * 3) / 2)}}.rt-tiles:not(.two) .mt:nth-last-child(3):nth-child(${L.tilesWideCols}n+1),.rt-tiles:not(.two) .mt:nth-last-child(3):nth-child(${L.tilesWideCols}n+1) ~ .mt{grid-column:span ${L.tilesWideCols}}}.rt-tiles.two{grid-template-columns:repeat(${L.tilesNarrowCols},minmax(0,1fr))}}
@container (max-width:${L.tilesOneColBreakpointPx}px){.rt-tiles,.rt-tiles.two{grid-template-columns:minmax(0,1fr)}.rt-tiles .mt{grid-column:auto}}
.rt-tiles .mt{padding:8px 9px}
.rt-chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0}
.rt-chips .chip{max-width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}
.act button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 10px;font:inherit;cursor:pointer}
.act button:hover{border-color:var(--acc);color:var(--acc)}
.act button[disabled]{opacity:.5;cursor:default}
.act button.cur{opacity:1;border-color:var(--acc);color:var(--acc);font-weight:600}
.act .tiercap{color:var(--dim);font-size:11px}
.act .msg{color:var(--dim);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis}
.act .msg.bad{color:var(--bad)}
.tiercap{color:var(--dim);font-size:11px}
.lbl{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0;color:var(--dim);font-size:11px}
.lbl input{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font:inherit;min-width:0;max-width:100%}
.lbl .lblbtn,.mhead .lblbtn{background:none;border:0;padding:0 4px;color:var(--acc);cursor:pointer;font:inherit}
.mhead .lblbtn{flex:0 0 auto;font-size:12px;line-height:1;align-self:center}
.mhead .lblact{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;min-width:32px;min-height:28px;padding:0 6px;margin-left:4px;font:inherit;cursor:pointer}
.mhead .lblmsg{font-size:11px;margin-left:6px}
.mhead input.lblin{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font:inherit;min-width:0;width:12em;max-width:100%}
.lbls{display:flex;flex-direction:column;gap:2px;min-width:0}
.tog.on{background:var(--acc);border-color:var(--acc);color:#fff}
`;
