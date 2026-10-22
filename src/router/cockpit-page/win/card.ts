/** cockpit-page/win — the card DOM factory and runtime (spec 2, 3.2, 4.1). Pure ES5 inside a string.
 *  Needs, in the same script scope: WIN_TREE_JS, WIN_LAYOUT_JS, WIN_MORPH_JS, WIN_STORE_JS
 *  (WIN_INFO_JS optional: with it the ⓘ renders and is wired). */

import { WIN_GUTTER_JS } from "./gutter.js";

/** The page-side shapes the ES5 code mirrors (types here are for the TS side only). */
export type WinCtx = {
  id: string;
  body: HTMLElement;
  text(k: string, s: string): void;
  attr(k: string, name: string, value: string | null): void;
  cls(k: string, name: string, on: boolean): void;
  html(k: string, html: string): void;
  list<T>(k: string, items: T[], keyFn: (it: T) => string, makeRow: (it: T) => HTMLElement, updateRow?: (row: HTMLElement, it: T) => void): void;
  title(s: string): void;
  status(kind: string, s: string): void;
  unstale(): void;
};
export type WinCardAction = { id: string; label: string; icon?: string; title?: string; enabled?: (ctx: WinCtx) => boolean | string; run?: (ctx: WinCtx) => void; pressed?: (ctx: WinCtx) => boolean; make?: (ctx: WinCtx) => HTMLElement };
export type WinCardSpec = { id: string; type: string; title: string; info?: string; actions?: WinCardAction[]; feeds?: string[] };
export type WinTypeDef = {
  accepts?: string[];
  minW?: number;
  minH?: number;
  defaultH?: number;
  mount?: (ctx: WinCtx) => void;
  update?: (ctx: WinCtx, data: unknown) => void;
  resize?: (ctx: WinCtx, w: number, h: number) => void;
  unmount?: (ctx: WinCtx) => void;
};

/** Win.init(main, defaults, opts) builds one absolutely placed .card per spec in defaults.cards
 *  (ids the loaded tree or group kids hold; the rest are ghosts or not drawn), from layout() rects:
 *    .card[data-card,data-type] > .chead (grip, title(+ⓘ), status, actions, minimize) + .cbody (contain:strict)
 *  defaults = { tree, kids, stDefaults, cards:[{id,type,title,info?,actions?,feeds?}] }.
 *  opts = { storage (default localStorage), now, cfg (partial: HEAD_H, GAP, minW) }.
 *  - Win.registerType(name, def) per 2.1; "group" is built in (accepts everything, no content).
 *  - mount(ctx) runs once, when the card is first shown un-minimized; update(ctx, data) per feed
 *    payload; resize(ctx, w, h) when the body box changes.
 *  - A spec may carry view(payload, ctx): its result is what update draws (null = skip); the generic types
 *    (win/types.ts: kv, table, note, list) draw only from that data and know no card ids.
 *  - Win.update(feed, payload): updates every mounted card whose feeds include feed (and replays
 *    the last payload when a minimized card is restored and mounts).
 *  - ctx per 4.1: text/attr/cls/html/list skip unchanged values; html is a keyed morph, list a
 *    keyed row list; title(str); status(kind, str) writes the header status slot ("" clears).
 *  - main gets an explicit height; a ResizeObserver on main re-runs layout only when its width changed; a card placed at another width re-fits every card to its content (grow and shrink).
 *  - minimize: Win.toggleMin(id) / the – + button; the card shows only its header (HEAD_H), the body
 *    is display:none but its state is kept; saved (debounced 150 ms, one write) with the layout. */
const WIN_CARD_BODY_JS = String.raw`var Win=(function(){
var HEAD_H=28,SAVE_MS=150,FIT_MAX=360,FIT_TBL_MAX=1200;
var TYPES={group:{accepts:["*"],minW:220,minH:HEAD_H+40,defaultH:300}};
var W={main:null,cards:{},order:[],tree:null,kids:null,st:null,cfg:null,store:null,opts:null,lastW:-1,n:0,last:{},timer:null,live:null,fed:{},rects:{},gut:{},gkey:"",gcfg:null,auto:false,fit:{},fitT:0,defRoot:[],tm:0};
function registerType(name,def){TYPES[name]=def||{}}
function el(tag,cls){var e=document.createElement(tag);if(cls)e.className=cls;return e}
function mkCtx(c){
 var slots={};
 function slot(k){
  var s=slots[k];
  if(!s||!c.body.contains(s)){s=c.body.querySelector('[data-k="'+k+'"]');slots[k]=s}
  return s;
 }
 var ctx={id:c.id,body:c.body,spec:c.spec};
 ctx.text=function(k,s){var e=slot(k);s=String(s==null?"":s);if(e&&e.textContent!==s)e.textContent=s};
 ctx.attr=function(k,name,v){var e=slot(k);if(!e)return;if(v===null||v===undefined){if(e.hasAttribute(name))e.removeAttribute(name)}else if(e.getAttribute(name)!==String(v))e.setAttribute(name,String(v))};
 ctx.cls=function(k,name,on){var e=slot(k);if(e&&e.classList.contains(name)!==!!on)e.classList.toggle(name,!!on)};
 ctx.html=function(k,h){var e=slot(k);if(e)winHtml(e,h)};
 ctx.list=function(k,items,keyFn,makeRow,updateRow){var e=slot(k);if(e)winList(e,items,keyFn,makeRow,updateRow)};
 ctx.title=function(s){setTitle(c,s)};
 ctx.status=function(kind,s){setStatus(c,kind,s)};
 // a data repaint ends a "stale" mark only: an action result (pending/ok/err) stays until its own timer or click
 ctx.unstale=function(){if(c.status.getAttribute("data-kind")==="stale")setStatus(c,"","")};
 return ctx;
}
function setTitle(c,s){
 s=String(s==null?"":s);
 if(c.titleText===s)return;c.tw=undefined;
 c.titleText=s;
 c.tt.textContent=s;c.title.setAttribute("title",s);
 c.el.setAttribute("aria-label",s);
 c.grip.setAttribute("aria-label","move "+s);
 c.handle.setAttribute("aria-label","height of "+s);
}
function setStatus(c,kind,s){
 s=String(s==null?"":s);kind=s?String(kind||""):"";
 if(c.status.textContent!==s)c.status.textContent=s;
 if(c.status.getAttribute("data-kind")!==kind){if(kind)c.status.setAttribute("data-kind",kind);else c.status.removeAttribute("data-kind")}
}
function announce(text){
 if(!W.live){W.live=el("div","cwlive");W.live.setAttribute("aria-live","polite");W.live.setAttribute("role","status");document.body.appendChild(W.live)}
 W.live.textContent=text;
}
function actionBtn(c,a){
 if(a.make)return a.make(c.ctx);
 var b=el("button","cbtn cact");b.type="button";b.setAttribute("data-act",a.id);
 b.textContent=(a.icon?a.icon+" ":"")+a.label;
 b.addEventListener("click",function(){if(!b.disabled)a.run(c.ctx)});
 return b;
}
/** enabled(ctx) -> true | false | "reason": a control is disabled with its reason in the title (rule 5). */
function paintActions(c){
 for(var i=0;i<c.acts.length;i++){
  var a=c.acts[i],b=c.actEls[i],en=a.enabled?a.enabled(c.ctx):true;
  var on=en===true,why=typeof en==="string"?en:(a.title||"");
  if(a.pressed){var pr=a.pressed(c.ctx)?"true":"false";if(b.getAttribute("aria-pressed")!==pr)b.setAttribute("aria-pressed",pr)}
  if(b.setDisabled){b.setDisabled(!on,on?"":why);continue}
  if(b.disabled!==!on)b.disabled=!on;
  if(why)b.title=why;else if(b.hasAttribute("title"))b.removeAttribute("title");
 }
}
function buildCard(spec){
 var c={id:spec.id,type:spec.type,spec:spec,mounted:false,box:"",bw:-1,bh:-1,titleText:null};
 if(spec.hidden){W.hide=W.hide||{};W.hide[spec.id]=1}
 var e=el("div","card");
 e.setAttribute("data-card",spec.id);e.setAttribute("data-type",spec.type);e.setAttribute("role","group");
 var head=el("div","chead");
 var grip=el("button","cgrip");grip.type="button";grip.setAttribute("aria-pressed","false");grip.textContent="⠿";
 var title=el("span","ctitle"),tt=el("span","ctt");title.appendChild(tt);
 if(spec.info&&typeof winInfoHtml==="function")title.insertAdjacentHTML("beforeend",winInfoHtml(spec.info));
 var status=el("span","cstatus");status.setAttribute("aria-live","polite");
 head.appendChild(grip);head.appendChild(title);head.appendChild(status);
 c.el=e;c.head=head;c.grip=grip;c.title=title;c.tt=tt;c.status=status;
 var body=el("div","cbody");body.style.contain="strict";
 c.body=body;
 c.ctx=mkCtx(c);
 c.acts=[];c.actEls=[];
 var acts=spec.actions||[];
 for(var i=0;i<acts.length;i++){
  // rule 5: a control is rendered only if it has a handler
  if(typeof acts[i].run!=="function"&&typeof acts[i].make!=="function")continue;
  c.acts.push(acts[i]);var b=actionBtn(c,acts[i]);c.actEls.push(b);head.appendChild(b);
 }
 var min=el("button","cbtn cmin");min.type="button";min.textContent="–";min.setAttribute("aria-expanded","true");
 min.addEventListener("click",function(){toggleMin(c.id)});
 status.addEventListener("click",function(){if(status.getAttribute("data-kind")==="err")setStatus(c,"","")});
 // the page turns the width control on (opts.span); it sits in the title so the header children stay grip, title, status, actions, minimize; a pointer control, not a tab stop (tabindex -1)
 if(W.opts&&W.opts.span){
  var sp=el("button","cbtn cspan");sp.type="button";sp.setAttribute("data-act","span");sp.tabIndex=-1;
  sp.addEventListener("click",function(){cycleSpan(c.id)});
  title.appendChild(sp);c.span=sp;
 }
 head.appendChild(min);c.min=min;if(c.span)paintSpan(c);
 e.appendChild(head);e.appendChild(body);
 // height handle (bottom-right "//"): drag, arrows or double-click change this card's height only; hidden on groups and when locked by CSS
 var hd=el("div","chandle");hd.tabIndex=0;hd.setAttribute("role","separator");hd.setAttribute("aria-orientation","horizontal");
 hd.title="drag to change height \u00b7 double-click: fit to content";hd.setAttribute("data-handle",spec.id);
 e.appendChild(hd);c.handle=hd;
 setTitle(c,spec.title);
 paintActions(c);
 min.title="minimize "+c.titleText;min.setAttribute("aria-label",min.title);
 return c;
}
/** Width share in the row: auto, 1/4, 1/3, 1/2, the whole row. st.sp holds the divisor (absent = auto). */
var SPAN_CYCLE=[0,4,3,2,1],SPAN_MARK={0:"\u2194",4:"\u00bc",3:"\u2153",2:"\u00bd",1:"1"},SPAN_NAME={0:"auto",4:"1/4",3:"1/3",2:"1/2",1:"full"};
function spanOf(id){var s=W.st&&W.st[id];return s&&s.sp>0?s.sp:0}
function paintSpan(c){
 if(!c.span)return;
 var v=spanOf(c.id);
 if(c.span.getAttribute("data-span")===SPAN_NAME[v])return;
 c.span.textContent=SPAN_MARK[v]||SPAN_MARK[0];
 c.span.title="width in the row: "+SPAN_NAME[v]+" \u00b7 click for "+SPAN_NAME[SPAN_CYCLE[(SPAN_CYCLE.indexOf(v)+1)%SPAN_CYCLE.length]];
 c.span.setAttribute("aria-label","width of "+(c.titleText||c.id)+": "+SPAN_NAME[v]);
 c.span.setAttribute("data-span",SPAN_NAME[v]);
}
function cycleSpan(id){
 var c=W.cards[id];if(!c||winLocked())return;
 var nx=SPAN_CYCLE[(SPAN_CYCLE.indexOf(spanOf(id))+1)%SPAN_CYCLE.length];
 W.st[id]=W.st[id]||{};
 if(nx)W.st[id].sp=nx;else delete W.st[id].sp;
 paintSpan(c);
 anchorKeep(relayout);save();
 announce(c.titleText+" width "+SPAN_NAME[nx]);
}
function isMin(id){var s=W.st[id];return!!s&&s.min===1}
/** layout state: unknown ids are ghosts (no space), known minimized cards carry min. */
function layState(){
 var o={},seen={},id,a,i,all=[];
 var rootIds=ids(W.tree);for(i=0;i<rootIds.length;i++)all.push(rootIds[i]);
 for(var g in W.kids){a=ids(W.kids[g]);for(i=0;i<a.length;i++)all.push(a[i])}
 for(i=0;i<all.length;i++){
  id=all[i];
  if(W.hide&&W.hide[id])o[id]={seen:1};
  else if(!W.cards[id]){o[id]={seen:(W.st[id]&&W.st[id].seen)||1}}
  else if(isMin(id))o[id]={min:1};
  else if(W.st[id]&&(W.st[id].h||W.st[id].sp||W.st[id].ub)){o[id]={};if(W.st[id].h)o[id].h=W.st[id].h;if(W.st[id].sp)o[id].sp=W.st[id].sp;if(W.st[id].ub)o[id].ub=1}
 }
 // a minimized card inside a group leaves its place (a ghost); it shows as a chip in the group's dock
 var dk=dockOf();for(var d in dk)for(i=0;i<dk[d].length;i++)o[dk[d][i]]={seen:1};
 return o;
}
/** {group id: [minimized card ids]} in tree order: the cards a group's dock shows as chips. */
function dockOf(){
 var o={},g,a,i,id;
 for(g in W.kids){
  if(!W.kids[g]||!W.kids[g].k)continue;
  a=ids(W.kids[g]);
  for(i=0;i<a.length;i++){id=a[i];if(W.cards[id]&&isMin(id)&&!(W.hide&&W.hide[id])){(o[g]=o[g]||[]).push(id)}}
 }
 return o;
}
/** A chip's least width: its title plus the restore button. */
function chipWs(){var o={},id;for(id in W.cards)if(isMin(id))o[id]=Math.min(240,Math.ceil((W.cards[id].titleText||"").length*6.6)+52);return o}
function paintMin(c){
 var m=isMin(c.id),r=W.rects&&W.rects[c.id];
 c.el.classList.toggle("min",m);
 c.el.classList.toggle("chip",m&&!!r&&!!r.chip);
 c.el.classList.toggle("nohd",!!r&&!!r.nohd);
 c.min.textContent=m?"+":"–";
 c.min.setAttribute("aria-expanded",m?"false":"true");
 c.min.setAttribute("aria-label",(m?"restore ":"minimize ")+c.titleText);
 c.min.title=(m?"restore ":"minimize ")+c.titleText;
}
/** cfg for layout: the registered types and each card's type by id (a metric is not laid out with the default minW). */
function cfgOf(){var lt={},id;for(id in W.cards)lt[id]=W.cards[id].type;W.cfg.types=TYPES;W.cfg.leafTypes=lt;W.cfg.titleW=titleWs();W.cfg.dock=dockOf();W.cfg.chipW=chipWs();W.cfg.fit=W.auto?fitCfg():undefined;W.cfg.derive=!W.auto;W.cfg.content=W.auto?undefined:contentOf();return W.cfg}
/** Frozen layout: the content height of each table/list card, read once per width and set of mounted cards (the layout gives a stack's leftover height to growable cards, never to these). */
function contentKey(){var n=0,id;for(id in W.cards)if(W.cards[id].mounted)n++;return W.main.clientWidth+":"+n}
function contentOf(){var k=contentKey();if(!W.content||W.contentKey!==k){W.content=fitReadAll();W.contentKey=k}return W.content}
/** Each card's title text width plus header controls, measured once the card is placed (c.tw; the status slot may truncate, so it is not counted); a new reading re-lays out once. */
/** The title element is stretched by flex, so its natural width is where its last child (text or info icon) ends. */
function titleText(c){return(c.span?c.span.previousSibling:c.title.lastChild).getBoundingClientRect().right-c.title.getBoundingClientRect().left}
function measureTitles(){
 var id,c,n=0;
 for(id in W.cards){
  c=W.cards[id];
  if(c.tw===undefined&&c.mounted&&c.head.clientWidth>0&&c.title.clientWidth>0){c.tw=Math.ceil(titleText(c)+c.head.clientWidth-c.title.clientWidth-(c.status.offsetWidth?c.status.offsetWidth+6:0));n++}
 }
 return n;
}
function titleWs(){var o={},id;for(id in W.cards)if(W.cards[id].tw!==undefined)o[id]=W.cards[id].tw;return o}
/** The fit readings for layout(): a type that draws at the body size (it has resize) has none; it keeps the height of its first
 *  placement, so its siblings still take their content height and nothing overflows. */
function fitCfg(){
 var f={},id,c;
 for(id in W.fit)f[id]=W.fit[id];
 for(id in W.cards){
  c=W.cards[id];
  if(!c.base||!(TYPES[c.type]||{}).resize||kidsOf(id)||fitNarrow(c)||fitPlain(c))continue;
  if(f[id]===undefined||c.type==="table")f[id]=c.base; // a table that gained rows leaves its note-sized reading
 }
 return f;
}
/** Auto layout (no saved layout, no user move yet): a default card is as tall as its content when its content first renders (then fixed; it only grows when the content would overflow). The content height of a card is
 *  its lowest leaf element, measured here; layout() (cfg.fit) turns the readings into band and card heights. A type that
 *  draws at the body size (it has resize) or a group has no reading and keeps its default height. */
/** A stacked (narrow) card that is not a chart is measured by its content like any other, though its type has a resize hook: its first placement is no reading. */
function fitNarrow(c){return c.type!=="chart"&&c.body.clientWidth>0&&c.body.clientWidth<W.cfg.narrowW}
/** A table or list card is measured by its content when it draws no table (a note, plain html, chips) or its spec's resize only re-flows the table to the width (fitTables): neither has anything to size to the body. */
function fitPlain(c){return c.mounted&&(c.type==="table"||c.type==="list"||c.id==="speed")&&(!c.body.querySelector("table")||!!c.spec.resize||(c.type==="table"&&c.body.querySelectorAll("tbody tr").length<=1))}
function fitEligible(c){
 return c.mounted&&!isMin(c.id)&&!kidsOf(c.id)&&(!(TYPES[c.type]||{}).resize||fitNarrow(c)||fitPlain(c))&&c.el.style.display!=="none"&&c.body.clientWidth>0;
}
/** Content height of every eligible card at once: each card is squeezed to its header (the body box is 0 high), where the
 *  body's scrollHeight is its content; heights and scroll offsets are put back before anything paints. */
function fitReadAll(){
 var out={},list=[],i,c;
 for(i=0;i<W.order.length;i++){c=W.cards[W.order[i]];if(c&&fitEligible(c))list.push(c)}
 var h=[],t=[];
 for(i=0;i<list.length;i++){h.push(list[i].el.style.height);t.push(list[i].body.scrollTop);list[i].el.style.height=HEAD_H+"px"}
 for(i=0;i<list.length;i++)out[list[i].id]=list[i].body.scrollHeight>0?Math.min(list[i].type==="chart"&&list[i].id!=="speed"?FIT_MAX:FIT_TBL_MAX,Math.ceil(list[i].body.scrollHeight)+8+HEAD_H):null;
 for(i=0;i<list.length;i++){list[i].el.style.height=h[i];list[i].body.scrollTop=t[i]}
 return out;
}
function refit(){
 W.fitT=0;
 var re=W.refit;W.refit=false;
 if(!W.auto||!W.main)return;
 var changed=false,id,all=fitReadAll();
 for(id in W.cards){
  var v=all[id];
  if(v===undefined||v===null)continue;
  // fitted when the card first has content; then only grown (a data update never makes a card jump), so the content never needs an inner scroll.
  // After a container width change every reading is replaced, shrinking included: the content wrapped differently at the new width.
  if(W.fit[id]===undefined||v>=W.fit[id]+2||(re&&v!==W.fit[id])){W.fit[id]=v;changed=true}
 }
 if(changed)relayout();
}
function scheduleFit(){
 if(!W.auto){W.content=null;return}
 if(W.fitT)return;
 W.fitT=1;if(typeof Promise!=="undefined")Promise.resolve().then(refit);else setTimeout(refit,0);
}
/** The first user move leaves auto layout: the heights on screen become the saved band px and group weights. */
function freeze(){
 if(!W.auto)return;
 W.auto=false;
 function bake(n,root){
  if(n.k!=="s")return;
  var i;
  if(n.d==="c")for(i=0;i<n.ch.length;i++){
   var e=winGExt(n.ch[i],W.rects);
   if(e&&e.y1>e.y0)n.sz[i]=e.y1-e.y0;
  }
  for(i=0;i<n.ch.length;i++)bake(n.ch[i],false);
 }
 bake(W.tree,true);
 for(var g in W.kids)if(W.kids[g]&&W.kids[g].k)bake(W.kids[g],false);
}
/** One feed payload into one card: a spec's view(payload, ctx) turns it into the data its (generic) type draws
 *  (null = nothing to draw); a type marked viewed draws nothing for a spec without a view. */
function feedCard(c,payload){
 var def=TYPES[c.type]||{},data=payload;
 if(!def.update)return;
 if(c.spec.view){data=c.spec.view(payload,c.ctx);if(data==null)return}
 else if(def.viewed)return;
 def.update(c.ctx,data);
}
function mountCard(c){
 var def=TYPES[c.type]||{};
 c.mounted=true;
 if(def.mount)def.mount(c.ctx);
 // replay the last payload of each feed the card listens to
 var f=c.spec.feeds||[];
 for(var i=0;i<f.length;i++)if(W.fed[f[i]]!==undefined)feedCard(c,W.fed[f[i]]);
 paintActions(c);
}
function place(c,r){
 var box=Math.round(r.x*100)/100+","+Math.round(r.y*100)/100+","+Math.round(r.w*100)/100+","+Math.round(r.h*100)/100;
 if(c.box!==box){
  if(W.auto&&c.pw!==undefined&&Math.abs(c.pw-r.w)>=1)W.refit=true; // a card at another width wraps its content differently: re-fit all
  c.pw=r.w;c.box=box;var s=c.el.style;
  s.left=r.x+"px";s.top=r.y+"px";s.width=r.w+"px";s.height=r.h+"px";
 }
}
/** Apply layout(): positions only. Content never reaches here (spec 3: layout takes no content). */
var _SHRUNK_LOGGED=false;
function relayout(){
 var w=W.main.clientWidth;
 if(w<=0)return;
 W.lastW=w;W.n++;
 var r=layout(W.tree,W.kids,{w:w},layState(),cfgOf());
 W.main.style.height=r.height+"px";
 W.rects=r.rects;
 if(W.cfg.shrunk&&!_SHRUNK_LOGGED){_SHRUNK_LOGGED=true;console.info("cockpit layout: "+W.cfg.shrunk+" stored band height(s) above their content were dropped")}
 W.cfg.shrunk=0;
 scheduleFit();
 for(var i=0;i<W.order.length;i++){
  var c=W.cards[W.order[i]],rect=r.rects[c.id];
  if(!rect){c.el.style.display="none";continue}
  if(c.el.style.display==="none")c.el.style.display="";
  place(c,rect);paintSpan(c);if(W.auto&&!c.base&&rect.h>0&&!isMin(c.id))c.base=rect.h;
  paintMin(c);
  var def=TYPES[c.type]||{};
  if(isMin(c.id))continue;
  if(!c.mounted&&!kidsOf(c.id))mountCard(c);
  if((c.bw!==rect.body.w||c.bh!==rect.body.h)){
   c.bw=rect.body.w;c.bh=rect.body.h;
   if(c.mounted&&def.resize)def.resize(c.ctx,rect.body.w,rect.body.h);
  }
 } paintGutters();
 if(!W.auto&&!W.cr&&W.contentKey!==contentKey()){W.cr=1;relayout();W.cr=0}
 if(measureTitles()&&W.tm<3){W.tm++;relayout();W.tm--}
}
/** Gutters (spec 3.3): one .wgutter in the GAP between siblings of every split, in the container that holds the
 *  split (main for the root tree, a group's body for its kids). Elements are kept by key so focus survives. */
function gutterBox(ea,eb,ax,gap){
 if(ax==="x")return{l:ea.x1,t:Math.min(ea.y0,eb.y0),w:gap,h:Math.max(ea.y1,eb.y1)-Math.min(ea.y0,eb.y0)};
 return{l:Math.min(ea.x0,eb.x0),t:ea.y1,w:Math.max(ea.x1,eb.x1)-Math.min(ea.x0,eb.x0),h:gap};
}
function gutterWalk(key,parent,tree,bounded,seen,state){
 var cfg=Object.create(cfgOf());cfg.bounded=bounded;cfg.kids=W.kids;
 (function walk(n,path){
  if(n.k!=="s")return;
  var i,j;
  for(i=0;i+1<n.ch.length;i++){
   if(!gutterAt(tree,path,i,state,W.rects,cfg))continue;
   var ea=winGExt(n.ch[i],W.rects),eb=winGExt(n.ch[i+1],W.rects),ax=n.d==="r"?"x":"y";
   var id=key+"|"+path.join(",")+"|"+i,g=W.gut[id];
   if(!g||g.parentNode!==parent){
    g=el("div","wgutter");g.tabIndex=0;g.setAttribute("role","separator");
    g.setAttribute("aria-orientation",ax==="x"?"vertical":"horizontal");
    g.setAttribute("aria-label","resize");
    g.setAttribute("data-key",key);g.setAttribute("data-path",path.join(","));g.setAttribute("data-index",String(i));g.setAttribute("data-axis",ax);
    parent.appendChild(g);W.gut[id]=g;
   }
   seen[id]=1;
   var b=gutterBox(ea,eb,ax,cfg.GAP),s=g.style;
   s.left=b.l+"px";s.top=b.t+"px";s.width=b.w+"px";s.height=b.h+"px";
  }
  for(j=0;j<n.ch.length;j++)walk(n.ch[j],path.concat([j]));
 })(tree,[]);
}
function paintGutters(){
 var seen={},state=layState(),id;
 if(W.tree)gutterWalk("",W.main,W.tree,false,seen,state);
 for(id in W.kids){
  var c=W.cards[id];
  if(c&&W.kids[id]&&W.kids[id].k&&!isMin(id)&&c.el.style.display!=="none")gutterWalk(id,c.body,W.kids[id],true,seen,state);
 }
 for(id in W.gut)if(!seen[id]){var g=W.gut[id];if(g.parentNode)g.parentNode.removeChild(g);delete W.gut[id]}
}
/** Which container a gutter event is for: sets the tree key and the bounded flag the shared cfg carries. */
function gutterFor(e){
 var g=e.target&&e.target.closest?e.target.closest(".wgutter"):null;
 if(!g)return;
 W.gkey=g.getAttribute("data-key")||"";
 W.gcfg=Object.create(cfgOf());W.gcfg.bounded=!!W.gkey;
}
function gutterOpts(){
 var o={
  getTree:function(){return W.gkey?W.kids[W.gkey]:W.tree},
  getRects:function(){return W.rects},
  getState:function(){return layState()},
  getKids:function(){return W.kids},
  preview:function(t){if(W.gkey)W.kids[W.gkey]=t;else W.tree=t;relayout()},
  apply:function(t){if(!W.gkey)markBands(W.tree,t);if(W.gkey)W.kids[W.gkey]=t;else W.tree=t;relayout();save()},
  announce:announce
 };
 Object.defineProperty(o,"cfg",{get:function(){return W.gcfg||cfgOf()}});
 return o;
}
/** A band whose px a gutter drag changed is the user's: it keeps its height (ub), the others follow their content. */
function markBands(was,now){
 if(!was||!now||was.k!=="s"||now.k!=="s"||was.d!=="c")return;
 for(var i=0;i<now.ch.length;i++)if(was.sz[i]!==now.sz[i]){var a=ids(now.ch[i]);for(var j=0;j<a.length;j++)(W.st[a[j]]=W.st[a[j]]||{}).ub=1}
}
function gutterWire(){
 var o=gutterOpts();
 document.addEventListener("pointerdown",gutterFor,true);
 document.addEventListener("keydown",function(e){
  gutterFor(e);
  if(e.target&&e.target.closest&&e.target.closest(".wgutter")&&winGutterKey(e,o,16))e.preventDefault();
 });
 winGutterDrag(document,window,o);
}
/** The tree (root or a group's kids) that holds leaf id, with its key. */
function treeOf(id){
 if(W.tree&&ids(W.tree).indexOf(id)>=0)return{key:"",tree:W.tree};
 for(var g in W.kids)if(W.kids[g]&&W.kids[g].k&&ids(W.kids[g]).indexOf(id)>=0)return{key:g,tree:W.kids[g]};
 return null;
}
/** The cards that resize together with card id: those of its row that sit on the same rendered line (equal top within 2 px). A card stacked under another, or on another line of a wrapped row, is alone. */
function lineOf(id){
 var c=W.cards[id],t=treeOf(id),p=t&&parentOf(t.tree,id),out=[id];
 if(!c||!p||p.d!=="r")return out;
 var top=c.el.getBoundingClientRect().top;
 for(var i=0;i<p.ch.length;i++){var sb=p.ch[i],o=sb.k==="c"&&sb.id!==id?W.cards[sb.id]:null;if(o&&!kidsOf(sb.id)&&o.el.style.display!=="none"&&Math.abs(o.el.getBoundingClientRect().top-top)<=2)out.push(sb.id)}
 return out;
}
/** Outline the cards that resize with id (null clears). */
function markLine(id){
 var m=document.querySelectorAll(".card.rz"),i;
 for(i=0;i<m.length;i++)m[i].classList.remove("rz");
 if(id)lineOf(id).forEach(function(k){if(W.cards[k])W.cards[k].el.classList.add("rz")});
}
/** A card's user height (the card's saved st.h; h null clears it). A row shares its line height: the siblings of the card
 *  in its row get the same user height, the whole line takes this one. Content taller than h scrolls inside the card.
 *  Frozen (non-auto) layouts size a group by band px, so the card's group band grows by the change; a start snapshot
 *  (tree + rects) makes every move of one drag absolute. */
function setHeight(id,h,snap,drag){
 var c=W.cards[id],s=W.st[id]=W.st[id]||{},t=treeOf(id);
 if(!c||!t)return;
 if(snap)W.tree=JSON.parse(snap.tree);
 if(h===null){
  delete s.h;
  lineOf(id).forEach(function(k){if(W.st[k])delete W.st[k].h});
 }else{
  var ty=TYPES[c.type]||{};
  s.h=Math.max(Math.round(h),ty.minH||W.cfg.minH||0,HEAD_H);
  lineOf(id).forEach(function(k){if(k!==id){var sbt=TYPES[W.cards[k].type]||{};(W.st[k]=W.st[k]||{}).h=Math.max(s.h,sbt.minH||W.cfg.minH||0,HEAD_H)}});
  if(!W.auto&&t.key&&snap){
   var keep=W.rects;W.rects=snap.rects;growBand(t.key,s.h-snap.h);W.rects=keep;
  }
 }
 // a drag keeps the pointer on the handle: the anchor must not scroll for the cards below that move with the height
 if(drag){relayout();if(typeof _ANCHOR!=="undefined"&&_ANCHOR)_ANCHOR.tracked=null}
 else anchorKeep(relayout);
}
function heightWire(){
 var cur=null;
 function card(e){var hd=e.target&&e.target.closest?e.target.closest(".chandle"):null;return hd?W.cards[hd.getAttribute("data-handle")]:null}
 document.addEventListener("pointerdown",function(e){
  if(winLocked())return;
  var c=card(e),r=c&&W.rects[c.id];
  if(!c||!r)return;
  var hd=c.handle;
  if(hd.setPointerCapture&&e.pointerId!==undefined)hd.setPointerCapture(e.pointerId);
  e.preventDefault();
  var keepSt=JSON.stringify(W.st);
  var snap={tree:JSON.stringify(W.tree),rects:W.rects,h:r.h};
  cur={c:c,y:e.clientY,snap:snap,st:keepSt};
  markLine(c.id);
 });
 document.addEventListener("pointermove",function(e){if(cur)setHeight(cur.c.id,cur.snap.h+e.clientY-cur.y,cur.snap,true)});
 document.addEventListener("pointerover",function(e){var c=card(e);if(c&&!cur&&!winLocked())markLine(c.id)});
 document.addEventListener("pointerout",function(e){if(card(e)&&!cur)markLine(null)});
 document.addEventListener("focusin",function(e){var c=card(e);if(c&&!winLocked())markLine(c.id)});
 document.addEventListener("focusout",function(e){if(card(e)&&!cur)markLine(null)});
 function end(commit){
  if(!cur)return;
  var d=cur;cur=null;markLine(null);
  if(!commit){W.tree=JSON.parse(d.snap.tree);W.st=JSON.parse(d.st);relayout();return}
  save();announce("height changed");
 }
 document.addEventListener("pointerup",function(){end(true)});
 document.addEventListener("pointercancel",function(){end(false)});
 document.addEventListener("keydown",function(e){
  if(cur&&e.key==="Escape"){end(false);return}
  var c=card(e);
  if(!c||winLocked()||(e.key!=="ArrowUp"&&e.key!=="ArrowDown"))return;
  var r=W.rects[c.id];if(!r)return;
  e.preventDefault();
  setHeight(c.id,r.h+(e.key==="ArrowUp"?-16:16),{tree:JSON.stringify(W.tree),rects:W.rects,h:r.h});
  save();announce("height changed");
 });
 document.addEventListener("dblclick",function(e){
  var c=card(e);
  if(!c||winLocked())return;
  W.refit=true;
  setHeight(c.id,null);save();announce("height fitted");
 });
}
/** The ResizeObserver callback: main's height is set by layout itself, so only a width change relayouts. */
function sync(){if(W.main.clientWidth!==W.lastW){relayout();return true}return false}
function kidsOf(id){return!!(W.kids&&W.kids[id]&&W.kids[id].k)}
/** The default tree's root cards are all in the tree: a layout composed before that (a warm-up page) is never persisted. */
function complete(){
 var have={},a=ids(W.tree),i;
 for(i=0;i<a.length;i++)have[a[i]]=1;
 for(var g in W.kids){a=ids(W.kids[g]);for(i=0;i<a.length;i++)have[a[i]]=1}
 for(i=0;i<W.defRoot.length;i++)if(!have[W.defRoot[i]])return false;
 return true;
}
function save(){
 W.dirtyT=Date.now();
 if(W.timer)clearTimeout(W.timer);
 W.timer=setTimeout(function(){
  W.timer=null;
  if(!complete())return;
  var now=W.opts.now||Date.now(),st={},id;
  for(id in W.st)st[id]=W.st[id];
  for(id in W.cards){st[id]=st[id]||{};st[id].seen=now}
  W.t=saveWin(W.opts.storage,W.tree,W.kids,st,W.auto);
 },SAVE_MS);
}
/** Another tab saved a layout (storage event): adopt it unless this tab changed its own later. The adopted layout is never
 *  written back, and this tab's pending debounced save is dropped (the newer save wins). While a grip or gutter is held
 *  the layout would change under the pointer, so it waits for the release. */
function adoptSaved(raw){
 var obj=parseWin(raw);
 if(!obj)return;
 var mine=W.timer?W.dirtyT:W.t;
 if(typeof obj.t==="number"&&typeof mine==="number"&&obj.t<mine)return;
 if(W.down){W.pendingRaw=raw;return}
 W.pendingRaw=null;
 if(W.timer){clearTimeout(W.timer);W.timer=null}
 var known=Object.keys(W.cards);
 var l=reconcileSaved(obj,W.defaults,known,Date.now());
 W.t=typeof obj.t==="number"?obj.t:Date.now();
 W.auto=W.auto&&obj.auto===1;
 var go=function(){W.tree=l.tree;W.kids=l.kids;W.st=l.st;relayout()};
 if(typeof anchorKeep==="function")anchorKeep(go);else go();
}
function crossTabWire(){
 window.addEventListener("storage",function(e){if(e.key===WIN_KEY&&e.newValue&&e.storageArea===W.opts.storage)adoptSaved(e.newValue)});
 var dn=function(e){if(e.target&&e.target.closest&&e.target.closest(".cgrip,.wgutter,.chandle"))W.down=1};
 var up=function(){if(!W.down)return;W.down=0;if(W.pendingRaw)setTimeout(function(){if(!W.down&&W.pendingRaw)adoptSaved(W.pendingRaw)},0)};
 document.addEventListener("pointerdown",dn,true);
 window.addEventListener("pointerup",up,true);window.addEventListener("pointercancel",up,true);
}
function toggleMin(id){
 var c=W.cards[id];if(!c||winLocked())return;
 W.st[id]=W.st[id]||{};
 W.st[id].min=isMin(id)?0:1;
 relayout();save();
 announce(c.titleText+(isMin(id)?" minimized":" restored"));
}
function update(feed,payload){
 W.fed[feed]=payload;
 var n=0;
 for(var i=0;i<W.order.length;i++){
  var c=W.cards[W.order[i]],f=c.spec.feeds||[],def=TYPES[c.type]||{};
  if(f.indexOf(feed)<0)continue;
  if(!c.mounted){if(kidsOf(c.id))paintActions(c);continue}
  feedCard(c,payload);
  paintActions(c);n++;
 }
 if(n)scheduleFit();
 return n;
}
/** Tree reading order, so Tab order = DOM order; a group's kids live inside its body.
 *  d is the nesting depth (0 = a root band): a group card carries it as data-depth, the level marker the CSS styles. */
function attach(parent,node,d){
 var order=ids(node);
 for(var i=0;i<order.length;i++){
  var c=W.cards[order[i]];
  if(!c)continue;
  parent.appendChild(c.el);W.order.push(c.id);
  if(kidsOf(c.id)){c.el.setAttribute("data-depth",String(d));c.body.style.overflow="hidden";c.body.classList.add("cgroup");attach(c.body,W.kids[c.id],d+1)}
 }
}
function init(main,defaults,opts){
 opts=opts||{};
 W.opts={storage:opts.storage||window.localStorage,now:opts.now,span:!!opts.span};
 W.defaults=defaults;W.main=main;W.cards={};W.order=[];W.fed={};W.last={};
 W.cfg={HEAD_H:HEAD_H,CHIP_H:22,GAP:8,GUTTER:8,minW:220,narrowW:480};
 if(opts.cfg)for(var k in opts.cfg)W.cfg[k]=opts.cfg[k];
 var specs=defaults.cards||[],known=[],i;
 for(i=0;i<specs.length;i++){W.cards[specs[i].id]=buildCard(specs[i]);known.push(specs[i].id)}
 var hadSaved=false;
 try{var sv=parseWin(W.opts.storage.getItem(WIN_KEY))||servedOf(defaults);hadSaved=!!sv&&sv.auto!==1}catch(e){}
 var l=loadWin(W.opts.storage,defaults,known,W.opts.now);
 W.auto=!hadSaved&&!opts.noFit;
 W.tree=l.tree;W.kids=l.kids;W.st=l.st;W.defRoot=ids(defaults.tree);
 main.classList.add("win");
 if(!main.__winGut){main.__winGut=1;gutterWire();heightWire()}
 if(!main.__winFlush){main.__winFlush=1;
  // a debounced save still pending when the page is left would be lost: write it now
  window.addEventListener("pagehide",function(){api.flush()});
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")api.flush()});
 }
 if(!main.__winTabs){main.__winTabs=1;crossTabWire()}
 if(!main.__winFreeze){main.__winFreeze=1;
  var fz=function(e){var t=e.target&&e.target.closest?e.target.closest(".cgrip,.wgutter"):null;if(t)freeze()};
  document.addEventListener("pointerdown",fz,true);document.addEventListener("keydown",fz,true);
 }
 if(typeof winInfoWire==="function"&&!main.__winInfo){main.__winInfo=1;winInfoWire(document,window)}
 // the cards present in the loaded tree, in reading order; the rest are not drawn
 var drawn={},ord=[];
 var a=ids(W.tree);for(i=0;i<a.length;i++)ord.push(a[i]);
 var all={};for(i=0;i<ord.length;i++)all[ord[i]]=1;
 for(var id in W.cards)if(!all[id]){var inKids=false;for(var g in W.kids)if(ids(W.kids[g]).indexOf(id)>=0)inKids=true;if(!inKids){delete W.cards[id]}}
 attach(main,W.tree,0);
 relayout();
 // any content write (feed, action status, a section's own paint) re-reads the content heights; style writes are not observed
 if(typeof MutationObserver!=="undefined"&&!main.__winMo){main.__winMo=1;new MutationObserver(scheduleFit).observe(main,{childList:true,subtree:true,characterData:true})}
 if(typeof ResizeObserver!=="undefined"){
  var ro=new ResizeObserver(sync);
  ro.observe(main);W.ro=ro;
 }else window.addEventListener("resize",sync);
 return api;
}
/** A structural change inside a group keeps what is on screen: the group column's weights become the px its children have now
 *  (px = {leaf id or child index: height}, new children their need), and the group's root band grows by delta (a removal: shrinks). Auto layout (no user move yet) is not touched: its fit readings size the band and the cards,
 *  so no sibling changes size and only the group and the cards below it move. Nothing to keep before the first layout. */
function groupPx(group,ch){
 var r=W.rects&&W.rects[group],px=[],i,e;
 if(W.auto||!r)return null;
 for(i=0;i<ch.length;i++){e=winGExt(ch[i],W.rects);if(!e)return null;px.push(e.y1-e.y0)}
 return px;
}
function growBand(group,delta){
 var t=W.tree,r=W.rects&&W.rects[group],i,e,g,up=true;
 if(!r||!t||t.k!=="s"||t.d!=="c")return;
 // a nested group (a group inside a group's body): the root band is the one holding its outermost group
 while(up){up=false;if(findLeaf(t,group))break;for(g in W.kids)if(W.kids[g]&&W.kids[g].k&&findLeaf(W.kids[g],group)){group=g;up=true;break}}
 for(i=0;i<t.ch.length;i++)if(findLeaf(t.ch[i],group)){
  e=winGExt(t.ch[i],W.rects);
  if(e)t.sz[i]=Math.max(HEAD_H,e.y1-e.y0+delta);
  return;
 }
}
/** Auto layout: a card added at runtime that will never be measured (it draws at the body size and is not a viewed type, or is a group) gets its type's default
 *  height as its fit reading at once, when the group it joins is sized by readings (every card has one). Without one the group has no
 *  content-driven heights and every card in it, and in the groups around it, falls back to weights. A group that had no readings
 *  before is left as it was. A measured card gets its reading on the next refit; other cards' readings are not touched. */
function seedFit(group,fresh){
 var kt=W.kids[group],r=W.rects&&W.rects[group],i,c,def;
 if(!kt||!kt.k||!r)return;
 var cfg=cfgOf();
 if(winFit(kt,r.w,layState(),cfg,W.kids)===null)return;
 for(i=0;i<fresh.length;i++){
  c=W.cards[fresh[i]];def=TYPES[c.type]||{};
  if(W.fit[c.id]===undefined&&def.defaultH&&!def.viewed&&(def.resize||c.type==="group"))W.fit[c.id]=def.defaultH;
 }
}
/** The group's nesting depth, read back from the DOM (the attach walk set it); 0 for a root group. */
function depthOf(id){
 var c=W.cards[id];
 if(!c)return 0;
 var d=c.el.closest("[data-depth]");
 return d?Number(d.getAttribute("data-depth"))+1:0;
}
/** Add cards by data (a structural change, spec 3.4): rows = [[id,...],...], one row split per entry, appended to
 *  the group's column. A row whose ids the group's tree already holds (a saved layout) only gets its cards built.
 *  The cards already in the group keep their size; the group grows by the new cards' need. */
function addCards(group,specs,rows){
 var g=W.cards[group],i,j,fresh=[],gd=depthOf(group);
 if(!g)return 0;
 for(i=0;i<specs.length;i++)if(!W.cards[specs[i].id]){W.cards[specs[i].id]=buildCard(specs[i]);fresh.push(specs[i].id)}
 if(!fresh.length)return 0;
 var have={},cur=W.kids[group]&&W.kids[group].k?W.kids[group]:null,a=cur?ids(cur):[],add=[];
 for(i=0;i<a.length;i++)have[a[i]]=1;
 for(i=0;i<rows.length;i++){
  var row=[];for(j=0;j<rows[i].length;j++)if(!have[rows[i][j]])row.push(leaf(rows[i][j]));
  if(row.length===rows[i].length)add.push(split("r",row,row.map(function(){return 1/row.length})));
  else for(j=0;j<row.length;j++)add.push(row[j]);
 }
 if(add.length){
  var ch=cur?(cur.d==="c"?cur.ch.slice():[cur]):[],n0=ch.length,px=n0?groupPx(group,ch):null,sz=ch.map(function(){return 1});
  for(i=0;i<add.length;i++)ch.push(add[i]);
  if(px){
   var bw=W.rects&&W.rects[group]?W.rects[group].w:0,st=layState(),cfg=cfgOf(),gap=W.cfg.GAP,delta=0;
   sz=px.slice();
   for(i=0;i<add.length;i++){var nd=Math.max(1,winNeed(add[i],bw,st,cfg,W.kids));sz.push(nd);delta+=nd+gap}
   growBand(group,delta);
  }else sz=ch.map(function(){return 1/ch.length});
  if(W.auto)seedFit(group,fresh);
  W.kids[group]=normalize(split("c",ch,sz),false);
 }
 g.body.style.overflow="hidden";g.body.classList.add("cgroup");
 for(i=0;i<fresh.length;i++){
  var fc=W.cards[fresh[i]];
  if(kidsOf(fc.id))fc.el.setAttribute("data-depth",String(gd+1));
  g.body.appendChild(fc.el);W.order.push(fc.id);
 }
 relayout();save();
 return fresh.length;
}
/** Remove cards from a group by data: the group shrinks by their share (and the gap), the remaining cards keep their size. */
function removeCards(group,idl){
 var tree=W.kids[group],i,n=0;
 if(!W.cards[group]||!tree||!tree.k)return 0;
 var gone=idl.filter(function(id){return!!W.cards[id]&&ids(tree).indexOf(id)>=0});
 if(!gone.length)return 0;
 var top=tree.d==="c"?tree.ch:[tree],keep=[],drop=[];
 for(i=0;i<top.length;i++)(ids(top[i]).every(function(id){return gone.indexOf(id)>=0})?drop:keep).push(top[i]);
 var kpx=groupPx(group,keep),dpx=groupPx(group,drop),delta=0;
 for(i=0;i<gone.length;i++){var c=W.cards[gone[i]];if(c.el.parentNode)c.el.parentNode.removeChild(c.el);delete W.cards[gone[i]];W.order.splice(W.order.indexOf(gone[i]),1);n++}
 for(i=0;i<gone.length;i++)tree=removeLeaf(tree,gone[i],false);
 if(kpx&&dpx){
  for(i=0;i<dpx.length;i++)delta-=dpx[i]+W.cfg.GAP;
  if(tree&&tree.k==="s"&&tree.ch.length===kpx.length)tree.sz=kpx.slice();
  growBand(group,delta);
 }
 if(tree)W.kids[group]=tree.k==="s"?normalize(tree,false):tree;
 relayout();save();
 return n;
}
/** Win.hide(id,on): a hidden card takes no space (a ghost to the layout), its place in the tree is kept. */
function hide(id,on){W.hide=W.hide||{};if(!!W.hide[id]===!!on)return;W.hide[id]=on?1:0;if(W.main)relayout()}
var api={init:init,addCards:addCards,removeCards:removeCards,hide:hide,registerType:registerType,update:update,relayout:relayout,sync:sync,layouts:function(){return W.n},toggleMin:toggleMin,
 ctx:function(id){return W.cards[id]?W.cards[id].ctx:null},
 el:function(id){return W.cards[id]?W.cards[id].el:null},
 state:function(){return{tree:W.tree,kids:W.kids,st:W.st}},fit:function(){return W.fit},auto:function(){return W.auto},
 cfg:cfgOf,announce:announce,layState:layState,
 /** Replace the root tree (key "") or a group's kids (key = group id), relayout once and save (A7). */
 apply:function(key,tree){if(key)W.kids[key]=tree;else W.tree=tree;relayout();save()},
 /** A drop: apply the moved tree and re-arrange (content-driven layout): fitted heights re-measure, narrow rows wrap into the grid, containers grow. */
 applyFit:function(key,tree){if(key)W.kids[key]=tree;else W.tree=tree;W.auto=true;W.refit=true;relayout();save()},
 /** The layout as it would be saved now (the "save as default" button posts it). */
 snapshot:function(){var st={},id,now=W.opts.now||Date.now();for(id in W.st)st[id]=W.st[id];for(id in W.cards){st[id]=st[id]||{};st[id].seen=now}var o={v:LAYOUT_V,t:Date.now(),tree:W.tree,kids:W.kids,st:st};if(W.auto)o.auto=1;return o},
 flush:function(){if(W.timer){clearTimeout(W.timer);W.timer=null;if(!complete())return;var st={},id,now=W.opts.now||Date.now();for(id in W.st)st[id]=W.st[id];for(id in W.cards){st[id]=st[id]||{};st[id].seen=now}W.t=saveWin(W.opts.storage,W.tree,W.kids,st,W.auto)}}};
return api;
})();
`;

/** The card runtime with the resize gutters (win/gutter.ts) it wires: one string, one scope. */
export const WIN_CARD_JS = `${WIN_GUTTER_JS}\n${WIN_CARD_BODY_JS}`;
