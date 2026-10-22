/** cockpit-page/win — resize gutters (spec 3.3): the gutter handle between two siblings
 *  resizes them. Pure weight/px arithmetic first (resizeSplit), pointer and keyboard
 *  wiring second. Pure ES5 inside a string. */

import type { WinNode } from "./tree.js";

/** The shapes the page script mirrors (types here are for the TS side only). */
export type WinGutterCfg = {
  GAP: number;
  HEAD_H?: number;
  minW: number;
  minH?: number;
  /** true when the tree is a group body: a column at splitPath [] holds weights, not band px */
  bounded?: boolean;
  leafTypes?: { [id: string]: string };
  types: { [name: string]: { minW?: number; minH?: number } };
};
export type WinResize = (
  tree: WinNode,
  splitPath: number[],
  index: number,
  deltaPx: number,
  rects: { [id: string]: { x: number; y: number; w: number; h: number } },
  state: { [id: string]: { min?: number; seen?: number } },
  cfg: WinGutterCfg,
  kids: { [id: string]: unknown },
) => WinNode | null;

/** Gutters, testable with new Function.
 *  A gutter sits in the GAP between ch[index] and ch[index+1] of the split at splitPath
 *  (child indices from the root; [] = the root itself). deltaPx moves that border right/down.
 *  resizeSplit(tree, splitPath, index, deltaPx, rects, state, cfg, kids) -> new tree | null.
 *  The tree is cloned; only the two neighbours' sz entries change.
 *  - row: weights; the weight moved is deltaPx / (the px the weights share) x (weight sum).
 *  - root column (splitPath [] and not cfg.bounded): sz are band px; the two bands trade
 *    deltaPx, other bands keep their px.
 *  - bounded column (path non-empty or cfg.bounded): weights of the height the non-minimized
 *    siblings share.
 *  Sizes are read from the laid-out rects (a split neighbour spans its leaves).
 *  Refused (null): bad path or index, a minimized or ghost neighbour, a row in narrow mode
 *  (stacked), no rects, or a neighbour below its minW/minH (a type's own value wins). */
export const WIN_GUTTER_JS = String.raw`function winGMinOf(cfg,kids,node,axis){
 var t={};
 if(node.k==="c"){
  var ty=cfg.leafTypes&&cfg.leafTypes[node.id];
  if(!ty){var k=kids&&kids[node.id];ty=k&&k.type?k.type:(k?"group":"leaf")}
  t=(cfg.types&&cfg.types[ty])||{};
 }
 if(axis==="x")return t.minW!==undefined?t.minW:cfg.minW;
 return t.minH!==undefined?t.minH:(cfg.minH||0);
}
function winGMin(st,id){var s=st&&st[id];return!!s&&!!s.min}
function winGGhost(st,id){var s=st&&st[id];return!!s&&s.seen!==undefined}
function winGClone(n){
 if(n.k==="c")return{k:"c",id:n.id};
 var ch=[],i;
 for(i=0;i<n.ch.length;i++)ch.push(winGClone(n.ch[i]));
 return{k:"s",d:n.d,ch:ch,sz:n.sz.slice()};
}
function winGAt(tree,path){
 var n=tree;
 for(var i=0;i<path.length;i++){
  if(!n||n.k!=="s"||!n.ch[path[i]])return null;
  n=n.ch[path[i]];
 }
 return n&&n.k==="s"?n:null;
}
/** Box a node spans (a leaf's rect; a split spans its drawn leaves), or null. */
function winGExt(n,rects){
 if(n.k==="c"){
  var r=rects&&rects[n.id];
  return r?{x0:r.x,x1:r.x+r.w,y0:r.y,y1:r.y+r.h}:null;
 }
 var e=null;
 for(var i=0;i<n.ch.length;i++){
  var c=winGExt(n.ch[i],rects);
  if(!c)continue;
  if(!e)e={x0:c.x0,x1:c.x1,y0:c.y0,y1:c.y1};
  else{e.x0=Math.min(e.x0,c.x0);e.x1=Math.max(e.x1,c.x1);e.y0=Math.min(e.y0,c.y0);e.y1=Math.max(e.y1,c.y1)}
 }
 return e;
}
function winGLeaves(n,out){
 if(n.k==="c")out.push(n.id);
 else for(var i=0;i<n.ch.length;i++)winGLeaves(n.ch[i],out);
 return out;
}
/** A node is a ghost/minimized neighbour when all its leaves are (a split: any leaf drawn). */
function winGAll(n,st,pred){
 var l=winGLeaves(n,[]);
 for(var i=0;i<l.length;i++)if(!pred(st,l[i]))return false;
 return l.length>0;
}
/** The layout's narrow test over a drawn row: some child's weight share is under its minW. */
function winGNarrowRow(s,rects,state,cfg){
 var i,e,x0=1e9,x1=-1e9,t=0,vis=[];
 for(i=0;i<s.ch.length;i++){
  if(winGAll(s.ch[i],state,winGGhost))continue;
  e=winGExt(s.ch[i],rects);
  if(!e)continue;
  vis.push(i);t+=s.sz[i]||0;x0=Math.min(x0,e.x0);x1=Math.max(x1,e.x1);
 }
 if(t<=0)return false;
 var total=x1-x0-(vis.length-1)*cfg.GAP;
 for(i=0;i<vis.length;i++){
  var n=s.ch[vis[i]];
  if((s.sz[vis[i]]||0)/t*total<winMinW(cfg,winLeafType(cfg.kids,n.id,cfg)))return true;
 }
 return false;
}
/** Where the gutter is and what it can do, or null:
 *  {s, mode:"band"|"row"|"col", ea, eb, ia, ib, ax, a, b, cell}.
 *  cell = the px the split's weights share (rows: widths; columns:
 *  heights of the non-minimized siblings). */
function winGInfo(tree,splitPath,index,rects,state,cfg){
 if(!tree||!splitPath)return null;
 var s=winGAt(tree,splitPath);
 if(!s||index<0||index+1>=s.ch.length)return null;
 var a=s.ch[index],b=s.ch[index+1];
 if(winGAll(a,state,winGGhost)||winGAll(b,state,winGGhost))return null;
 var ea=winGExt(a,rects),eb=winGExt(b,rects);
 if(!ea||!eb)return null;
 var band=s.d==="c"&&splitPath.length===0&&!cfg.bounded;
 var ax=s.d==="r"?"x":"y";
 if(ax==="x"&&eb.x0<=ea.x0)return null; // narrow mode: the row is stacked
 if(ax==="x"&&winGNarrowRow(s,rects,state,cfg))return null; // narrow mode: the row wraps into a grid of equal widths
 if(winGAll(a,state,winGMin)||winGAll(b,state,winGMin))return null;
 var cell=0,i;
 if(!band){
  for(i=0;i<s.ch.length;i++){
   if(winGAll(s.ch[i],state,winGGhost))continue;
   if(ax==="y"&&winGAll(s.ch[i],state,winGMin))continue;
   var e=winGExt(s.ch[i],rects);
   if(e)cell+=ax==="x"?e.x1-e.x0:e.y1-e.y0;
  }
  if(!(cell>0))return null;
 }
 return{s:s,mode:band?"band":(ax==="x"?"row":"col"),ea:ea,eb:eb,ia:index,ib:index+1,ax:ax,a:a,b:b,cell:cell};
}
/** Weight/px arithmetic on a clone. Returns the new tree or null (below a minimum). */
function resizeSplit(tree,splitPath,index,deltaPx,rects,state,cfg,kids){
 var g=winGInfo(tree,splitPath,index,rects,state,cfg);
 if(!g||!deltaPx&&deltaPx!==0)return null;
 var sa=g.ax==="x"?g.ea.x1-g.ea.x0:g.ea.y1-g.ea.y0;
 var sb=g.ax==="x"?g.eb.x1-g.eb.x0:g.eb.y1-g.eb.y0;
 var na=sa+deltaPx,nb=sb-deltaPx;
 if(na<winGMinOf(cfg,kids,g.a,g.ax)||nb<winGMinOf(cfg,kids,g.b,g.ax))return null;
 var out=winGClone(tree),ns=winGAt(out,splitPath);
 if(g.mode==="band"){ns.sz[g.ia]=na;ns.sz[g.ib]=nb;return out}
 // weights: the pair keeps its combined weight, split in proportion to the new px
 var pair=ns.sz[g.ia]+ns.sz[g.ib];
 ns.sz[g.ia]=pair*na/(na+nb);
 ns.sz[g.ib]=pair*nb/(na+nb);
 return out;
}
/** The gutter between two siblings for the wiring: {path,index,a,b,cell} or null. */
function gutterAt(tree,splitPath,index,state,rects,cfg){
 var g=winGInfo(tree,splitPath,index,rects,state,cfg);
 if(!g)return null;
 var cell=g.cell;
 if(g.mode==="band")cell=Math.max(g.ea.x1,g.eb.x1)-Math.min(g.ea.x0,g.eb.x0);
 else if(g.mode==="row")cell=cell+(winGVisible(g.s,state)-1)*cfg.GAP;
 return{path:splitPath.slice(),index:index,a:g.a.id||"",b:g.b.id||"",cell:cell};
}
function winGVisible(s,st){
 var n=0;
 for(var i=0;i<s.ch.length;i++)if(!winGAll(s.ch[i],st,winGGhost))n++;
 return n;
}
/** Read data-path / data-index / data-axis off a .wgutter element. */
function winGParse(g){
 var p=g.getAttribute("data-path"),idx=parseInt(g.getAttribute("data-index"),10);
 if(isNaN(idx))return null;
 return{path:p?p.split(",").map(Number):[],index:idx,axis:g.getAttribute("data-axis")||"x"};
}
/** Pointer drag: winGutterDrag(doc,win,opts) listens for pointerdown on .wgutter and
 *  returns a detach function. opts: {getTree,getRects,getState,getKids,cfg,apply(tree),
 *  preview(tree),announce(text)}. pointermove resizes from the start tree by the px moved
 *  (a refused move keeps the last accepted tree); pointerup applies once; Escape or
 *  pointercancel restores the start tree. */
function winGutterDrag(doc,win,opts){
 function down(e){
  var g=e.target&&e.target.closest?e.target.closest(".wgutter"):null;
  var p=g?winGParse(g):null;
  if(!p)return;
  var base=opts.getTree(),rects=opts.getRects(),state=opts.getState();
  if(!gutterAt(base,p.path,p.index,state,rects,opts.cfg))return;
  var from=p.axis==="x"?e.clientX:e.clientY,cur=null;
  if(g.setPointerCapture&&e.pointerId!==undefined)g.setPointerCapture(e.pointerId);
  if(e.preventDefault)e.preventDefault();
  function mv(m){
   var d=(p.axis==="x"?m.clientX:m.clientY)-from;
   var n=resizeSplit(base,p.path,p.index,d,rects,state,opts.cfg,opts.getKids());
   if(n){cur=n;if(opts.preview)opts.preview(n)}
  }
  function stop(){
   doc.removeEventListener("pointermove",mv);
   doc.removeEventListener("pointerup",up);
   doc.removeEventListener("pointercancel",cancel);
   doc.removeEventListener("keydown",key);
  }
  function up(){stop();if(cur){if(opts.apply)opts.apply(cur);if(opts.announce)opts.announce("resized")}}
  function cancel(){stop();if(cur&&opts.preview)opts.preview(base)}
  function key(k){if(k.key==="Escape")cancel()}
  doc.addEventListener("pointermove",mv);
  doc.addEventListener("pointerup",up);
  doc.addEventListener("pointercancel",cancel);
  doc.addEventListener("keydown",key);
 }
 doc.addEventListener("pointerdown",down);
 return function(){doc.removeEventListener("pointerdown",down)};
}
/** Keyboard: arrows on a focused gutter resize by step px (default 16); one layout
 *  operation per press. Returns true when the key was for a gutter (even if refused). */
function winGutterKey(e,opts,step){
 var g=e.target&&e.target.closest?e.target.closest(".wgutter"):null;
 var p=g?winGParse(g):null;
 if(!p)return false;
 var k=e.key,neg=k==="ArrowLeft"||k==="ArrowUp";
 if(!neg&&k!=="ArrowRight"&&k!=="ArrowDown")return false;
 if((p.axis==="x")!==(k==="ArrowLeft"||k==="ArrowRight"))return false;
 var n=resizeSplit(opts.getTree(),p.path,p.index,(step||16)*(neg?-1:1),opts.getRects(),opts.getState(),opts.cfg,opts.getKids());
 if(n){opts.apply(n);if(opts.announce)opts.announce("resized")}
 return true;
}
`;
