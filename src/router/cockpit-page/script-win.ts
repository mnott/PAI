/** cockpit-page — the win runtime on the page: the A-core strings in their own function scope (their
 *  helper names do not meet the page's), the cards of every section, and Win.init on main#win-root. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";
import { WIN_TREE_JS } from "./win/tree.js";
import { WIN_LAYOUT_JS } from "./win/layout.js";
import { WIN_MORPH_JS } from "./win/morph.js";
import { WIN_STORE_JS } from "./win/store.js";
import { WIN_INFO_JS } from "./win/info.js";
import { WIN_ANCHOR_JS } from "./win/anchor.js";
import { WIN_CARD_JS } from "./win/card.js";
import { WIN_TYPES_JS } from "./win/types.js";
import { WIN_KPIS_JS } from "./win/cards-kpis.js";
import { WIN_POOL_JS } from "./win/cards-pool.js";
import { WIN_SYSTEM_JS } from "./win/cards-system.js";
import { WIN_MEMORY_JS } from "./win/cards-memory.js";
import { WIN_ROUTING_JS } from "./win/cards-routing.js";
import { WIN_CLOUD_JS } from "./win/cards-cloud.js";
import { WIN_WORKERS_JS } from "./win/cards-workers.js";
import { WIN_MODELS_JS } from "./win/cards-models.js";
import { WIN_REGISTRY_JS } from "./win/cards-registry.js";
import { WIN_CACHE_JS } from "./win/cards-cache.js";
import { WIN_ACTIONS_JS } from "./win/actions.js";
import { WIN_CHARTS_JS } from "./win/cards-charts.js";
import { WIN_TABLES_JS } from "./win/cards-tables.js";
import { WIN_SELECT_JS } from "./win/select.js";

/** The runtime source: the pure parts plus the card runtime, returning {Win, leaf, split, anchorInit}. */
export const WIN_RUNTIME_JS = [WIN_TREE_JS, WIN_LAYOUT_JS, WIN_MORPH_JS, WIN_STORE_JS, WIN_INFO_JS, WIN_ANCHOR_JS, WIN_CARD_JS].join("\n");

export const scriptWin = (_L: CockpitLayout, _n: Num, _q: Str, _hex: Str): string => String.raw`/* win runtime */
/*win-begin*/
var Win=null,WinT=null,WinA=null,WIN_HOST=null;
{
 WinT=(function(){
${WIN_RUNTIME_JS}
  return{Win:Win,leaf:leaf,split:split,anchorInit:anchorInit};
 })();
 Win=WinT.Win;window.Win=Win;
}
{
 WinA=(function(){
${WIN_ACTIONS_JS}
${WIN_SELECT_JS}
  return{Select:Select,Menu:Menu,runAction:runAction,winClick:winClick};
 })();
 WIN_HOST={fetch:function(u,o){return fetch(u,o)},setStatus:function(id,k,t){var c=Win.ctx(id);if(c)c.status(k,t)},setBusy:function(id,on,el){if(!el)return;if(el.setDisabled)el.setDisabled(on);else el.disabled=!!on},clearStatus:function(id){var c=Win.ctx(id);if(c)c.status("","")},refresh:function(f){if(f&&f.indexOf("memory")>=0&&typeof loadMemory==="function")loadMemory()},announce:function(t){Win.announce(t)}};
}
/** The action runner's host for the routing cards: no section refresh (the limits poll repaints). */
function winHost(){
 return{fetch:WIN_HOST.fetch,setStatus:WIN_HOST.setStatus,setBusy:WIN_HOST.setBusy,clearStatus:WIN_HOST.clearStatus,refresh:function(){},announce:WIN_HOST.announce};
}
${WIN_TYPES_JS}
${WIN_KPIS_JS}
${WIN_POOL_JS}
${WIN_SYSTEM_JS}
${WIN_CHARTS_JS}
${WIN_TABLES_JS}
${WIN_MEMORY_JS}
${WIN_ROUTING_JS}
${WIN_CLOUD_JS}
${WIN_WORKERS_JS}
${WIN_MODELS_JS}
${WIN_REGISTRY_JS}
${WIN_CACHE_JS}
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
  var root=document.getElementById("win-root");
  Win.init(root,winCompose([[kpiDefaults(),118],[poolDefaults(),340],[sysDefaults(),900],[memDefaults(),300],[routingDefaults(),330],[limLocalDefaults(),220],[limCloudDefaults(),240],[cacheDefaults(),620],[workersDefaults(),420],[modelsDefaults(),520]].concat(chartsDefaults().parts).concat(tablesDefaults().parts).concat([[registryDefaults(),460]])));
  wrgStart();
  window.winFeedModels=winFeedModels;window.winFeedSystem=winFeedSystem;window.winFeedMemory=winFeedMemory;window.winFeedLimits=winFeedLimits;
  WinT.anchorInit(document,window,root);
 })();
/*win-end*/
`;
