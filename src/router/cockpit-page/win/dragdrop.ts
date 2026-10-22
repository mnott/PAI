/** cockpit-page/win — pointer and keyboard drag wired to moveCard (spec 3.3, 5.3). Pure ES5 inside a string.
 *  Needs, in the same script scope: WIN_DROP_JS (zoneAt, moveCard, neighbor, ids), WIN_CARD_JS (Win),
 *  WIN_ANCHOR_JS (anchorKeep; optional, falls back to a bare call). `edgeScroll(y)` is reused when the page
 *  defines it. No backticks inside the string: the tests extract it up to the closing one.
 *
 *  winDragInit(doc, win, opts) -> { cancel, grabbed }
 *  opts: { pressMs (touch long-press, default 400) }
 *  Pointer: pointerdown on a .cgrip (mouse arms at once, touch after pressMs); listeners on window;
 *    the drag holds ids, never nodes. Zones come from zoneAt on the live card rects of the same container;
 *    the .dropind bar sits on that edge; a drop always applies and the layout re-arranges afterwards.
 *    Nothing reflows during the drag; pointerup applies once inside anchorKeep.
 *    Esc / pointercancel / blur cancel: the tree was never touched.
 *  Keyboard: Enter/Space on a grip grabs (aria-pressed=true); arrows move the card to the other side of
 *    the nearest neighbour in that direction (applied step by step); Enter/Space drops; Esc restores the
 *    tree from before the grab. Alt+arrow moves without grabbing. Focus stays on the grip by id.
 *    Every move is announced: "moved <title> right of <other>". */
export const WIN_DRAGDROP_JS = String.raw`var DD_ARROW={ArrowLeft:"left",ArrowRight:"right",ArrowUp:"up",ArrowDown:"down"};
var DD_ZONE={left:"left",right:"right",up:"top",down:"bottom"};
function ddClone(o){return JSON.parse(JSON.stringify(o))}
/** The container holding id: {key:"" for the root or the group id, tree}. */
function ddContainer(id){
 var s=Win.state();
 if(s.tree&&ids(s.tree).indexOf(id)>=0)return{key:"",tree:s.tree};
 for(var g in s.kids)if(s.kids[g]&&ids(s.kids[g]).indexOf(id)>=0)return{key:g,tree:s.kids[g]};
 return null;
}
/** Box handed to dropTry: root = width only (h undefined selects the root-band rule), group = its body. */
function ddBox(key){
 if(!key)return{w:Win.el(ddFirst()).parentNode.clientWidth};
 var e=Win.el(key);
 var b=e&&e.querySelector(".cbody");
 return b?{w:b.clientWidth,h:b.clientHeight}:{w:10000,h:10000};
}
function ddFirst(){var s=Win.state();return ids(s.tree)[0]}
/** Live rects of the drawn cards of one container, keyed by id. */
function ddRects(tree,skip){
 var o={},a=ids(tree);
 for(var i=0;i<a.length;i++){
  var e=Win.el(a[i]);
  if(!e||a[i]===skip||e.style.display==="none")continue;
  var r=e.getBoundingClientRect();
  o[a[i]]={x:r.left,y:r.top,w:r.width,h:r.height};
 }
 return o;
}
function ddTitle(id){var e=Win.el(id);var t=e&&e.querySelector(".ctt");return t?t.textContent:id}
/** moveCard cannot see card types (leaves carry only an id), so the dragged card brings its band
 *  height: its type's defaultH, else its current box height. */
function ddState(id){
 var st=Win.layState(),cfg=Win.cfg(),e=Win.el(id),t=cfg.types&&cfg.types[e.getAttribute("data-type")];
 var s=st[id]=st[id]||{};
 if(s.px===undefined)s.px=(t&&t.defaultH)||Math.round(e.getBoundingClientRect().height);
 return st;
}
function ddMove(c,dragId,targetId,zone){
 return dropTry(c.tree,dragId,targetId,zone,{kids:Win.state().kids,state:ddState(dragId),cfg:Win.cfg(),box:ddBox(c.key)});
}
function ddApply(key,tree){
 if(typeof anchorKeep==="function")anchorKeep(function(){Win.applyFit(key,tree)});
 else Win.applyFit(key,tree);
}
/** The edge bar for a zone on rect R (viewport px, position:fixed). */
function ddBar(R,zone){
 var T=4;
 if(zone==="left")return{x:R.x,y:R.y,w:T,h:R.h};
 if(zone==="right")return{x:R.x+R.w-T,y:R.y,w:T,h:R.h};
 if(zone==="top")return{x:R.x,y:R.y,w:R.w,h:T};
 return{x:R.x,y:R.y+R.h-T,w:R.w,h:T};
}
function winDragInit(doc,win,opts){
 opts=opts||{};
 var PRESS=opts.pressMs===undefined?400:opts.pressMs;
 var D=null,ind=null,K=null;
 function showInd(R,zone){
  if(!ind){ind=doc.createElement("div");ind.className="dropind";doc.body.appendChild(ind)}
  var b=ddBar(R,zone),s=ind.style;
  s.left=b.x+"px";s.top=b.y+"px";s.width=b.w+"px";s.height=b.h+"px";
  ind.setAttribute("data-zone",zone);
 }
 function hideInd(){if(ind){ind.remove();ind=null}}
 function status(id,kind,s){var c=Win.ctx(id);if(c)c.status(kind,s)}
 function refocus(id){var e=Win.el(id);var g=e&&e.querySelector(".cgrip");if(g)g.focus()}
 /** The card under the pointer in the dragged card's container, with its zone. */
 function hit(x,y){
  var c=ddContainer(D.id);
  if(!c)return null;
  var rs=ddRects(c.tree,D.id);
  for(var tid in rs){
   var R=rs[tid];
   if(x<R.x||x>=R.x+R.w||y<R.y||y>=R.y+R.h)continue;
   var z=zoneAt(R,{x:x,y:y});
   return z==="none"?null:{c:c,tid:tid,zone:z,R:R};
  }
  return null;
 }
 function feedback(h){
  D.drop=null;
  if(!h){hideInd();status(D.id,"","");return}
  var t=ddMove(h.c,D.id,h.tid,h.zone).tree;
  if(t===null||t===h.c.tree){hideInd();status(D.id,"","");return}
  showInd(h.R,h.zone);
  status(D.id,"","");
  if(t!==null)D.drop={c:h.c,tree:t};
 }
 function endPointer(){
  if(!D)return;
  if(D.timer)clearTimeout(D.timer);
  win.removeEventListener("pointermove",onMove);
  win.removeEventListener("touchmove",onTouchMove);
  win.removeEventListener("pointerup",onUp);
  win.removeEventListener("pointercancel",onCancel);
  win.removeEventListener("blur",onCancel);
  win.removeEventListener("keydown",onEsc);
  hideInd();
  var e=Win.el(D.id);if(e)e.classList.remove("dragging");
  D=null;
 }
 function onMove(e){
  if(!D)return;
  if(!D.armed){
   // touch: moving before the long-press fires is a scroll, not a drag
   if(Math.abs(e.clientX-D.x0)+Math.abs(e.clientY-D.y0)>6){endPointer()}
   return;
  }
  D.moved=true;
  var el=Win.el(D.id);if(el)el.classList.add("dragging");
  if(typeof edgeScroll==="function")edgeScroll(e.clientY);
  feedback(hit(e.clientX,e.clientY));
  if(e.cancelable)e.preventDefault();
 }
 /** Armed touch: the finger drags the card, so the page must not pan under it. Unarmed, the browser pans and sends pointercancel. */
 function onTouchMove(e){if(D&&D.armed&&e.cancelable)e.preventDefault()}
 function onUp(e){
  if(!D)return;
  var id=D.id,drop=D.drop,moved=D.moved;
  if(moved)feedback(hit(e.clientX,e.clientY));
  drop=D.drop;
  endPointer();
  if(drop&&moved&&drop.tree!==drop.c.tree){
   ddApply(drop.c.key,drop.tree);
   Win.announce("moved "+ddTitle(id));
  }
 }
 function onCancel(){if(D){status(D.id,"","");endPointer()}}
 function onEsc(e){if(e.key==="Escape")onCancel()}
 function onDown(e){
  var g=e.target.closest?e.target.closest(".cgrip"):null;
  if(!g||D||K||(e.button&&e.button!==0))return;
  var card=g.closest(".card");
  if(!card)return;
  D={id:card.getAttribute("data-card"),moved:false,armed:false,timer:null,drop:null,x0:e.clientX,y0:e.clientY};
  win.addEventListener("pointermove",onMove);
  win.addEventListener("touchmove",onTouchMove,{passive:false});
  win.addEventListener("pointerup",onUp);
  win.addEventListener("pointercancel",onCancel);
  win.addEventListener("blur",onCancel);
  win.addEventListener("keydown",onEsc);
  if(e.pointerType==="touch")D.timer=setTimeout(function(){if(D){D.timer=null;D.armed=true}},PRESS);
  else D.armed=true;
  e.preventDefault();
 }
 // keyboard (5.3)
 function grip(id){var e=Win.el(id);return e&&e.querySelector(".cgrip")}
 function kbMove(id,dir){
  var c=ddContainer(id);
  if(!c)return false;
  var nb=neighbor(ddRects(c.tree),id,dir);
  if(!nb)return false;
  var r=ddMove(c,id,nb,DD_ZONE[dir]),t=r.tree;
  if(!t||t===c.tree)return false;
  ddApply(c.key,t);
  Win.announce("moved "+ddTitle(id)+" "+(dir==="up"?"above":dir==="down"?"below":dir+" of")+" "+ddTitle(nb));
  refocus(id);
  return true;
 }
 function drop(){
  if(!K)return;
  var id=K.id,g=grip(id);
  if(g)g.setAttribute("aria-pressed","false");
  K=null;
  Win.announce("dropped "+ddTitle(id));
 }
 function restore(){
  if(!K)return;
  var id=K.id,g=grip(id);
  if(K.moved)ddApply(K.key,K.before);
  if(g)g.setAttribute("aria-pressed","false");
  K=null;
  Win.announce("move cancelled");
  refocus(id);
 }
 function onKey(e){
  var g=e.target.closest?e.target.closest(".cgrip"):null;
  if(K&&e.key==="Escape"){restore();e.preventDefault();return}
  if(!g)return;
  var card=g.closest(".card"),id=card&&card.getAttribute("data-card");
  if(!id)return;
  if(e.key==="Enter"||e.key===" "){
   e.preventDefault();
   if(K){drop();return}
   var c=ddContainer(id);
   if(!c)return;
   K={id:id,key:c.key,before:ddClone(c.tree),moved:false};
   g.setAttribute("aria-pressed","true");
   Win.announce("grabbed "+ddTitle(id)+", use arrow keys to move, Enter to drop, Escape to cancel");
   return;
  }
  var dir=DD_ARROW[e.key];
  if(!dir)return;
  if(K&&K.id===id){e.preventDefault();if(kbMove(id,dir))K.moved=true}
  else if(e.altKey){e.preventDefault();kbMove(id,dir)}
 }
 doc.addEventListener("pointerdown",onDown);
 doc.addEventListener("keydown",onKey);
 return{cancel:onCancel,grabbed:function(){return K?K.id:null},stop:function(){doc.removeEventListener("pointerdown",onDown);doc.removeEventListener("keydown",onKey);onCancel()}};
}
`;
