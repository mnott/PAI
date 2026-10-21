/** cockpit-page — the win runtime on the page, behind ?win=1 (spec 7 preamble): the A-core strings in
 *  their own function scope (their helper names do not meet the page's), the converted sections' cards,
 *  and Win.init on main#win-root. Without the flag nothing here runs and the old page is untouched. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";
import { WIN_TREE_JS } from "./win/tree.js";
import { WIN_LAYOUT_JS } from "./win/layout.js";
import { WIN_MORPH_JS } from "./win/morph.js";
import { WIN_STORE_JS } from "./win/store.js";
import { WIN_INFO_JS } from "./win/info.js";
import { WIN_ANCHOR_JS } from "./win/anchor.js";
import { WIN_CARD_JS } from "./win/card.js";
import { WIN_KPIS_JS } from "./win/cards-kpis.js";
import { WIN_POOL_JS } from "./win/cards-pool.js";

/** The runtime source: the pure parts plus the card runtime, returning {Win, leaf, split, anchorInit}. */
export const WIN_RUNTIME_JS = [WIN_TREE_JS, WIN_LAYOUT_JS, WIN_MORPH_JS, WIN_STORE_JS, WIN_INFO_JS, WIN_ANCHOR_JS, WIN_CARD_JS].join("\n");

export const scriptWin = (_L: CockpitLayout, _n: Num, _q: Str, _hex: Str): string => String.raw`/* win runtime (?win=1) */
/*win-begin*/
var WINON=/[?&]win=1(&|$)/.test(location.search),Win=null,WinT=null;
if(WINON){
 WinT=(function(){
${WIN_RUNTIME_JS}
  return{Win:Win,leaf:leaf,split:split,anchorInit:anchorInit};
 })();
 Win=WinT.Win;window.Win=Win;
}
if(WINON){
${WIN_KPIS_JS}
${WIN_POOL_JS}
 /** The sections' defaults as root bands: [[defaults, band px], ...] in page order. */
 function winCompose(parts){
  var leaves=[],px=[],cards=[],kids={},st={},i,k;
  for(i=0;i<parts.length;i++){
   var d=parts[i][0];
   leaves.push(d.tree);px.push(parts[i][1]);
   cards=cards.concat(d.cards);
   for(k in d.kids)kids[k]=d.kids[k];
   for(k in d.stDefaults)st[k]=d.stDefaults[k];
  }
  return{tree:WinT.split("c",leaves,px),kids:kids,stDefaults:st,cards:cards};
 }
 (function(){
  var root=document.getElementById("win-root"),old=document.querySelector('[data-section="kpis"]');
  if(!root)return;
  root.hidden=false;document.body.classList.add("winon");
  // the converted section lives in the new root; its old container stays in the DOM (the old render still fills it) but is not shown
  if(old)old.style.display="none";
  var oldPool=document.querySelector('[data-section="pool"]');if(oldPool)oldPool.style.display="none";
  Win.init(root,winCompose([[kpiDefaults(),118],[poolDefaults(),340]]));
  WinT.anchorInit(document,window,root);
 })();
}
/*win-end*/
`;
