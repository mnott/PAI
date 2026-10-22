/** cockpit-page/win — the card DOM factory and runtime (spec 2, 3.2, 4.1). Pure ES5 inside a string.
 *  Needs, in the same script scope: WIN_TREE_JS, WIN_LAYOUT_JS, WIN_MORPH_JS, WIN_STORE_JS
 *  (WIN_INFO_JS optional: with it the ⓘ renders and is wired). */

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
 *    .card[data-card,data-type] > .chead (grip, title(+ⓘ), status, actions, minimize) + .cbody
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
var HEAD_H=28,GAP=6,SAVE_MS=150;
var TYPES={group:{accepts:["*"],minW:220,minH:HEAD_H+40,defaultH:300}};
var W={main:null,cards:{},order:[],tree:null,kids:null,st:null,cfg:null,store:null,opts:null,lastW:-1,n:0,last:{},timer:null,live:null,fed:{},defRoot:[],bro:null};
function registerType(name,def){TYPES[name]=def||{}}
/** winLocked() is the one owner of "is the layout locked": the html.locked class, set from pai.cockpit.lock by the page. */
function winLocked(){return typeof document!=="undefined"&&!!document.documentElement&&document.documentElement.classList.contains("locked")}
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
 if(c.titleText===s)return; c.titleText=s;
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
 var c={id:spec.id,type:spec.type,spec:spec,mounted:false,bw:-1,bh:-1,titleText:null,mw:0,wu:null,uh:null,chip:false};
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
 var body=el("div","cbody");
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
 head.appendChild(min);c.min=min;
 e.appendChild(head);e.appendChild(body);
 // height handle (bottom-right "//"): drag, arrows or double-click change this card's height only; hidden on groups and when locked by CSS
 var hd=el("div","chandle");hd.tabIndex=0;hd.setAttribute("role","separator");hd.setAttribute("aria-orientation","horizontal");
 hd.title="drag to resize \u00b7 double-click to reset";hd.setAttribute("data-handle",spec.id);
 e.appendChild(hd);c.handle=hd;
 setTitle(c,spec.title);
 paintActions(c);
 min.title="minimize "+c.titleText;min.setAttribute("aria-label",min.title);
 return c;
}
function isMin(id){var s=W.st[id];return!!s&&s.min===1}
function kidsOf(id){return!!(W.kids&&W.kids[id]&&W.kids[id].k)}
/** The least-width bucket (px) of a card's type: the CSS promotes a card to a wider step when its container is narrower than its span needs at this width. */
function mwOf(c){
 var m=(TYPES[c.type]||{}).minW||220,b=[120,160,200,240,300,360],i;
 if(kidsOf(c.id)&&m<220)m=220;
 for(i=0;i<b.length;i++)if(m<=b[i])return b[i];
 return b[b.length-1];
}
/** The container the card sits in, its content width: the width the 12 columns share. */
function contentW(p){var cs=getComputedStyle(p);return p.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)}
/** The width in units for a card dragged to targetW px: the step nearest to it whose width keeps the card's least width; 0 without a container. */
function stepFor(id,targetW){
 var c=W.cards[id],p=c&&c.el.parentNode;
 if(!p||!(p.clientWidth>0))return 0;
 return winStepFor(contentW(p),GAP,c.mw,targetW);
}
function mkDock(){var d=el("div","cdock");d.setAttribute("aria-label","minimized");return d}
/** Put the elements of cs into host in order, moving only what is out of place. */
function inOrder(host,cs){
 var ref=host.firstElementChild,i;
 for(i=0;i<cs.length;i++){
  if(cs[i].el===ref)ref=ref.nextElementSibling;
  else host.insertBefore(cs[i].el,ref);
 }
}
/** The DOM follows the tree: every card sits in the grid of the group whose kids hold it, in tree order; a minimized card of a group sits in the group's dock
 *  (the last item of its grid). Nothing is positioned: this only moves elements. d is the nesting depth of host (0 = the page). */
function reparent(host,tree,d,dead){
 var list=tree?ids(tree):[],cards=[],chips=[],i,c,dock=host.__dock||null;
 for(i=0;i<list.length;i++){
  c=W.cards[list[i]];
  if(!c)continue;
  W.order.push(c.id);
  if(d>0&&isMin(c.id))chips.push(c);else cards.push(c);
 }
 if(d>0){
  if(!dock)dock=host.__dock=mkDock();
  if(host.lastElementChild!==dock)host.appendChild(dock);
 }
 inOrder(host,cards);
 if(dock)inOrder(dock,chips);
 var all=cards.concat(chips);
 // a group whose one visible card is itself an open group draws no header for that child: its cards fill the parent body
 var vis=cards.filter(function(x){return!(W.hide&&W.hide[x.id])});
 for(i=0;i<all.length;i++)all[i].el.classList.toggle("nohd",vis.length===1&&vis[0]===all[i]&&d>0&&kidsOf(all[i].id)&&!isMin(all[i].id));
 for(i=0;i<all.length;i++){
  c=all[i];
  if(kidsOf(c.id)){
   c.el.setAttribute("data-depth",String(d));
   if(!c.body.classList.contains("cgroup"))c.body.classList.add("cgroup");
   reparent(c.body,W.kids[c.id],d+1,dead||isMin(c.id));
  }else if(c.el.hasAttribute("data-depth"))c.el.removeAttribute("data-depth");
  c.chip=chips.indexOf(c)>=0;c.dead=!!dead;
 }
}
function paintMin(c){
 var m=isMin(c.id);
 c.el.classList.toggle("min",m);
 c.el.classList.toggle("chip",m&&!!c.chip);
 c.min.textContent=m?"+":"–";
 c.min.setAttribute("aria-expanded",m?"false":"true");
 c.min.setAttribute("aria-label",(m?"restore ":"minimize ")+c.titleText);
 c.min.title=(m?"restore ":"minimize ")+c.titleText;
}
/** The card's stored size onto its element: width units as an attribute the CSS spans, the user's height on the body. */
function paintSize(c){
 var s=W.st[c.id],w=s&&s.w?String(s.w):"",h=s&&s.h&&!kidsOf(c.id)?Math.max(s.h,HEAD_H+40)-HEAD_H:0;
 var m=mwOf(c);
 if(c.mw!==m){c.mw=m;c.el.setAttribute("data-mw",String(m))}
 if(c.wu!==w){c.wu=w;if(w)c.el.setAttribute("data-w",w);else c.el.removeAttribute("data-w")}
 if(c.uh!==h){c.uh=h;c.body.style.height=h?h+"px":"";if(h)c.el.setAttribute("data-uh","1");else c.el.removeAttribute("data-uh")}
}
/** The body box of every mounted card handed to its type's resize(ctx,w,h) when it changed. */
function syncBodies(){
 for(var i=0;i<W.order.length;i++){
  var c=W.cards[W.order[i]];
  if(!c||!c.mounted||c.dead||isMin(c.id)||c.el.style.display==="none")continue;
  var w=c.body.clientWidth,h=c.body.clientHeight,def=TYPES[c.type]||{};
  if(w>0&&(c.bw!==w||c.bh!==h)){c.bw=w;c.bh=h;if(def.resize)def.resize(c.ctx,w,h)}
 }
}
/** Apply the tree and the card states to the DOM. The browser lays the cards out (CSS grid). */
function relayout(){
 W.n++;
 W.order=[];
 var fa=document.activeElement;
 reparent(W.main,W.tree,0,false);
 // moving an element in the DOM drops its focus: give it back
 if(fa&&fa!==document.body&&fa!==document.activeElement&&document.contains(fa)&&fa.focus)fa.focus({preventScroll:true});
 var i,c,hid;
 for(i=0;i<W.order.length;i++){
  c=W.cards[W.order[i]];
  hid=!!(W.hide&&W.hide[c.id]);
  if(hid!==(c.el.style.display==="none"))c.el.style.display=hid?"none":"";
  paintSize(c);paintMin(c);
  if(hid||c.dead||isMin(c.id)||kidsOf(c.id)||c.mounted)continue;
  mountCard(c);
  if(W.bro)W.bro.observe(c.body);
 }
 // a card no tree holds (a group's kids were replaced) takes no space
 var placed={};
 for(i=0;i<W.order.length;i++)placed[W.order[i]]=1;
 for(var id in W.cards)if(!placed[id]&&W.cards[id].el.style.display!=="none")W.cards[id].el.style.display="none";
 syncBodies();
}
/** A card's user height (the card's saved st.h; h null clears it back to its content height). Content taller than h scrolls inside the card. */
function setHeight(id,h,drag){
 var c=W.cards[id],s=W.st[id]=W.st[id]||{};
 if(!c)return;
 if(h===null)delete s.h;
 else s.h=Math.max(Math.round(h),HEAD_H+40);
 // a drag keeps the pointer on the handle: the anchor must not scroll for the cards below that move with the height
 if(drag){relayout();if(typeof _ANCHOR!=="undefined"&&_ANCHOR)_ANCHOR.tracked=null}
 else anchorKeep(relayout);
}
function heightWire(){
 var cur=null;
 function card(e){var hd=e.target&&e.target.closest?e.target.closest(".chandle"):null;return hd?W.cards[hd.getAttribute("data-handle")]:null}
 document.addEventListener("pointerdown",function(e){
  if(winLocked())return;
  var c=card(e);
  if(!c)return;
  var hd=c.handle,r=c.el.getBoundingClientRect();
  if(hd.setPointerCapture&&e.pointerId!==undefined)hd.setPointerCapture(e.pointerId);
  e.preventDefault();
  cur={c:c,x:e.clientX,y:e.clientY,w:r.width,h:r.height,st:JSON.stringify(W.st)};
 });
 document.addEventListener("pointermove",function(e){
  if(!cur)return;
  // the handle also sets the width: snapped to the 12-column steps of the card's group
  var dx=e.clientX-cur.x;
  if(Math.abs(dx)>=8){var u=stepFor(cur.c.id,cur.w+dx);if(u)(W.st[cur.c.id]=W.st[cur.c.id]||{}).w=u}
  var dy=e.clientY-cur.y;
  // a height is stored only once the drag moves vertically: a sideways drag leaves the card as tall as its content
  if(cur.vy||Math.abs(dy)>=6){cur.vy=1;setHeight(cur.c.id,cur.h+dy,true)}
  else relayout();
 });
 function end(commit){
  if(!cur)return;
  var d=cur;cur=null;
  if(!commit){W.st=JSON.parse(d.st);relayout();return}
  save();announce("size changed");
 }
 document.addEventListener("pointerup",function(){end(true)});
 document.addEventListener("pointercancel",function(){end(false)});
 document.addEventListener("keydown",function(e){
  if(cur&&e.key==="Escape"){end(false);return}
  var c=card(e);
  if(!c||winLocked()||(e.key!=="ArrowUp"&&e.key!=="ArrowDown"))return;
  e.preventDefault();
  setHeight(c.id,c.el.getBoundingClientRect().height+(e.key==="ArrowUp"?-16:16));
  save();announce("height changed");
 });
 document.addEventListener("dblclick",function(e){
  var c=card(e);
  if(!c||winLocked())return;
  setHeight(c.id,null);if(W.st[c.id])delete W.st[c.id].w;anchorKeep(relayout);save();announce("size reset");
 });
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
  W.t=saveWin(W.opts.storage,W.tree,W.kids,st);
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
 var go=function(){W.tree=l.tree;W.kids=l.kids;W.st=l.st;relayout()};
 if(typeof anchorKeep==="function")anchorKeep(go);else go();
}
function crossTabWire(){
 window.addEventListener("storage",function(e){if(e.key===WIN_KEY&&e.newValue&&e.storageArea===W.opts.storage)adoptSaved(e.newValue)});
 var dn=function(e){if(e.target&&e.target.closest&&e.target.closest(".cgrip,.chandle"))W.down=1};
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
 return n;
}
function init(main,defaults,opts){
 opts=opts||{};
 W.opts={storage:opts.storage||window.localStorage,now:opts.now};
 W.defaults=defaults;W.main=main;W.cards={};W.order=[];W.fed={};W.last={};
 var specs=defaults.cards||[],known=[],i;
 for(i=0;i<specs.length;i++){W.cards[specs[i].id]=buildCard(specs[i]);known.push(specs[i].id)}
 var l=loadWin(W.opts.storage,defaults,known,W.opts.now);
 W.tree=l.tree;W.kids=l.kids;W.st=l.st;W.defRoot=ids(flatDefaults(defaults).tree);
 main.classList.add("win");
 if(!main.__winGut){main.__winGut=1;heightWire()}
 if(!main.__winFlush){main.__winFlush=1;
  // a debounced save still pending when the page is left would be lost: write it now
  window.addEventListener("pagehide",function(){api.flush()});
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")api.flush()});
 }
 if(!main.__winTabs){main.__winTabs=1;crossTabWire()}
 if(typeof winInfoWire==="function"&&!main.__winInfo){main.__winInfo=1;winInfoWire(document,window)}
 // the cards present in the loaded tree, in reading order; the rest are not drawn
 var all={};
 var a=ids(W.tree);for(i=0;i<a.length;i++)all[a[i]]=1;
 for(var g0 in W.kids){a=ids(W.kids[g0]);for(i=0;i<a.length;i++)all[a[i]]=1}
 for(var id in W.cards)if(!all[id])delete W.cards[id];
 // a card body that changes size (the window, a width step, a height) tells its type: charts and tables redraw at that size
 if(typeof ResizeObserver!=="undefined"){W.bro=new ResizeObserver(syncBodies)}
 relayout();
 return api;
}
/** Add cards by data (a structural change, spec 3.4): rows = [[id,...],...], appended in order to the group's kids; the cards of a row
 *  of n share the line (width 12/n units). A card the group's tree already holds (a saved layout) only gets built. */
function addCards(group,specs,rows){
 var g=W.cards[group],i,j,fresh=[];
 if(!g)return 0;
 for(i=0;i<specs.length;i++)if(!W.cards[specs[i].id]){W.cards[specs[i].id]=buildCard(specs[i]);fresh.push(specs[i].id)}
 if(!fresh.length)return 0;
 var list=W.kids[group]&&W.kids[group].k?ids(W.kids[group]):[],have={};
 for(i=0;i<list.length;i++)have[list[i]]=1;
 for(i=0;i<rows.length;i++){
  var row=rows[i].filter(function(id){return!have[id]});
  for(j=0;j<row.length;j++){
   list.push(row[j]);
   if(row.length===rows[i].length&&row.length>1){var s=W.st[row[j]]=W.st[row[j]]||{};if(s.w===undefined)s.w=unitsOf(1/row.length)}
  }
 }
 W.kids[group]=listTree(list);
 relayout();save();
 return fresh.length;
}
/** Remove cards from a group by data: the group shrinks to the remaining content. */
function removeCards(group,idl){
 var tree=W.kids[group],i,n=0;
 if(!W.cards[group]||!tree||!tree.k)return 0;
 var gone=idl.filter(function(id){return!!W.cards[id]&&ids(tree).indexOf(id)>=0});
 if(!gone.length)return 0;
 for(i=0;i<gone.length;i++){var c=W.cards[gone[i]];if(c.el.parentNode)c.el.parentNode.removeChild(c.el);delete W.cards[gone[i]];n++}
 for(i=0;i<gone.length;i++)tree=removeLeaf(tree,gone[i],false);
 if(tree)W.kids[group]=tree;else delete W.kids[group];
 relayout();save();
 return n;
}
/** Win.hide(id,on): a hidden card takes no space, its place in the tree is kept. */
function hide(id,on){W.hide=W.hide||{};if(!!W.hide[id]===!!on)return;W.hide[id]=on?1:0;if(W.main)relayout()}
/** Put a whole tree + kids (a drop, an undo) in place, with the widths a drop sets ({id: units}) or the whole card state of an undo: relayout once and save. */
function applyAll(tree,kids,sizes,st){
 W.tree=tree;W.kids=kids;
 if(st)W.st=JSON.parse(st);
 for(var id in sizes||{})(W.st[id]=W.st[id]||{}).w=sizes[id];
 relayout();save();
}
/** The result of dropping dragId at zone of targetId ({tree,kids,sizes}), without applying it; null when the drop changes nothing.
 *  The widths follow the gesture: above/below a card is a line of its own (full width); beside a full-width card both take half, beside a narrower one the dropped card takes its width. */
function tryMove(dragId,targetId,zone){
 var r=moveCard(W.tree,W.kids,dragId,targetId,zone);
 if(!r)return null;
 var tw=(W.st[targetId]&&W.st[targetId].w)||12,sizes={};
 if(zone==="top"||zone==="bottom"||zone==="into")sizes[dragId]=12;
 else if(tw===12){sizes[dragId]=6;sizes[targetId]=6}
 else sizes[dragId]=tw;
 r.sizes=sizes;
 return r;
}
var api={init:init,addCards:addCards,removeCards:removeCards,hide:hide,registerType:registerType,update:update,relayout:relayout,sync:syncBodies,layouts:function(){return W.n},toggleMin:toggleMin,
 ctx:function(id){return W.cards[id]?W.cards[id].ctx:null},
 el:function(id){return W.cards[id]?W.cards[id].el:null},
 main:function(){return W.main},isGroup:kidsOf,
 state:function(){return{tree:W.tree,kids:W.kids,st:W.st}},stJson:function(){return JSON.stringify(W.st)},
 announce:announce,tryMove:tryMove,applyAll:applyAll,
 /** Replace the root tree (key "") or a group's kids (key = group id), relayout once and save (A7). */
 apply:function(key,tree){tree=flatTree(tree,W.st);if(key)W.kids[key]=tree;else W.tree=tree;relayout();save()},
 /** The layout as it would be saved now (the "save as default" button posts it). */
 snapshot:function(){var st={},id,now=W.opts.now||Date.now();for(id in W.st)st[id]=W.st[id];for(id in W.cards){st[id]=st[id]||{};st[id].seen=now}var o={v:LAYOUT_V,t:Date.now(),tree:W.tree,kids:W.kids,st:st};return o},
 flush:function(){if(W.timer){clearTimeout(W.timer);W.timer=null;if(!complete())return;var st={},id,now=W.opts.now||Date.now();for(id in W.st)st[id]=W.st[id];for(id in W.cards){st[id]=st[id]||{};st[id].seen=now}W.t=saveWin(W.opts.storage,W.tree,W.kids,st)}}};
return api;
})();
`;

export const WIN_CARD_JS = WIN_CARD_BODY_JS;
