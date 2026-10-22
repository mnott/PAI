/** cockpit-page/win — drag/drop tree ops (spec 3.3). Pure ES5 inside a string.
 *  Mirrors WIN_LAYOUT_JS: the same tree/kids/state/cfg inputs, no DOM. */

import type { WinNode, WinLeaf, WinSplit } from "./tree.js";
import type { WinBox, WinState, WinCfg, WinRect } from "./layout.js";

export type WinZone = "left" | "right" | "top" | "bottom" | "none";
export type WinDrop = (
  tree: WinNode | null,
  dragId: string,
  targetId: string,
  zone: WinZone,
  opts: { kids: { [groupId: string]: WinNode | null }; state: { [id: string]: WinState }; cfg: WinCfg },
) => WinNode | null;

/** zoneAt(rect, p) -> "left"|"right"|"top"|"bottom"|"none": the four edge bands are the
 *  outer 25% of width/height; corners go to the nearer edge by distance; the middle is
 *  "none". moveCard(tree,dragId,targetId,zone,{kids,state,cfg}) -> the new tree per 3.3
 *  (remove + normalize, insert by zone, normalize), or null only for an impossible drop (onto itself,
 *  unknown card, zone none). A drop is never refused for room: the layout re-arranges afterwards
 *  (refit of fitted heights, narrow rows wrap into the balanced grid).
 *  dropTry(...) -> {tree,why}: moveCard; why is always "".
 *  neighbor(rects,id,dir) -> the id of the nearest visible card in that direction, or null.
 *  canDrop(tree,kids,state,cfg,dragId,targetId,zone,box) -> true|false: moveCard would not return null.
 *  A drop that yields the identical tree returns the tree unchanged (no-op).
 *  No backticks inside the string: the tests extract it up to the closing one. */
export const WIN_DROP_JS = String.raw`
function winClone(n){
 if(!n)return null;
 if(n.k==="c")return{k:"c",id:n.id};
 var ch=[],sz=[],i;
 for(i=0;i<n.ch.length;i++){ch.push(winClone(n.ch[i]));sz.push(n.sz[i])}
 return{k:"s",d:n.d,ch:ch,sz:sz};
}
/** The four edge bands of R (outer 25% of width/height); corners to the nearer edge by
 *  distance; the middle is "none". A point outside R is "none" (not a target). */
function zoneAt(R,p){
 if(!R||!p)return"none";
 if(p.x<R.x||p.y<R.y||p.x>=R.x+R.w||p.y>=R.y+R.h)return"none";
 var ew=R.w*0.25,eh=R.h*0.25;
 var L=p.x-R.x,RT=R.x+R.w-p.x,T=p.y-R.y,B=R.y+R.h-p.y;
 var hx=L<ew||RT<ew,hy=T<eh||B<eh;
 if(!hx&&!hy)return"none";
 if(hx&&hy){
  var dx=Math.min(L,RT),dy=Math.min(T,B);
  if(dx<=dy)return L<RT?"left":"right"; // tie: horizontal wins
  return T<B?"top":"bottom";
 }
 if(hx)return L<ew?"left":"right";
 return T<eh?"top":"bottom";
}
/** The drop result per 3.3: {tree,why:""}; tree is null only for a structurally impossible drop (onto itself, unknown card, zone none). Never refused for room. */
function dropTry(tree,dragId,targetId,zone,opts){
 opts=opts||{};
 var kids=opts.kids||{},st=opts.state||{},cfg=opts.cfg||{HEAD_H:28,GAP:8,minW:220,types:{}};
 var box=opts.box||{w:10000,h:10000};
 if(!tree||dragId===targetId||zone==="none")return{tree:null,why:""};
 if(!findLeaf(tree,dragId)||!findLeaf(tree,targetId))return{tree:null,why:""};
 var rootCol=tree.k==="s"&&tree.d==="c";
 // 1. remove D on a clone (root band px kept; an emptied band is gone)
 var t=removeLeaf(winClone(tree),dragId,true);
 // 2. T's parent after removal
 var T=findLeaf(t,targetId);
 if(!T)return{tree:null,why:""};
 var P=parentOf(t,targetId);
 var horiz=zone==="left"||zone==="right";
 var after=zone==="right"||zone==="bottom";
 var dir=horiz?"r":"c";
 var D=leaf(dragId);
 if(P&&P.d===dir&&!(dir==="c"&&P===t&&box.h===undefined)){
  // same direction as the parent: D becomes a sibling, T's weight halves
  var i=P.ch.indexOf(T),w=P.sz[i]||0;
  P.ch.splice(after?i+1:i,0,D);
  P.sz.splice(after?i+1:i,0,w/2);
  P.sz[i]=w/2;
 }else if(P&&P===t&&P.d==="c"&&dir==="c"){
  // root column, top/bottom: D gets its own band of remembered px or defaultH
  var k=P.ch.indexOf(T),px=winPx(st,dragId);
  var h=px!==null?px:winDefH(cfg,winLeafType(kids,dragId,cfg));
  P.ch.splice(after?k+1:k,0,D);
  P.sz.splice(after?k+1:k,0,h);
 }else{
  // other direction (or T is the root leaf): T becomes a split [D,T]/[T,D], 0.5/0.5
  var ns=split(dir,after?[T,D]:[D,T],[0.5,0.5]);
  if(!P)t=ns;
  else P.ch[P.ch.indexOf(T)]=ns;
 }
 // 5. normalize; a root column keeps its band: T's band px, even when it collapsed to one card
 t=normalize(t,true);
 if(rootCol&&!(t.k==="s"&&t.d==="c")){
  var bi=0;
  for(var q=0;q<tree.ch.length;q++)if(findLeaf(tree.ch[q],targetId))bi=q;
  t=split("c",[t],[tree.sz[bi]]);
 }
 // no-op: the identical tree comes back unchanged
 return{tree:same(tree,t)?tree:t,why:""};
}
/** The drop result per 3.3, or null for an impossible drop. */
function moveCard(tree,dragId,targetId,zone,opts){return dropTry(tree,dragId,targetId,zone,opts).tree}
function same(a,b){
 if(a===b)return true;
 if(!a||!b||a.k!==b.k)return false;
 if(a.k==="c")return a.id===b.id;
 if(a.d!==b.d||a.ch.length!==b.ch.length)return false;
 for(var i=0;i<a.ch.length;i++)if(a.sz[i]!==b.sz[i]||!same(a.ch[i],b.ch[i]))return false;
 return true;
}
/** The id of the nearest visible card in direction dir ("left"|"right"|"up"|"down"),
 *  or null. Overlap on the perpendicular axis required; distance is the edge gap. */
function neighbor(rects,id,dir){
 var R=rects&&rects[id];
 if(!R)return null;
 var best=null,bd=Infinity;
 for(var oid in rects){
  if(oid===id)continue;
  var O=rects[oid];
  var d;
  if(dir==="left"){if(O.x+O.w>R.x)continue;d=R.x-(O.x+O.w)}
  else if(dir==="right"){if(O.x<R.x+R.w)continue;d=O.x-(R.x+R.w)}
  else if(dir==="up"){if(O.y+O.h>R.y)continue;d=R.y-(O.y+O.h)}
  else if(dir==="down"){if(O.y<R.y+R.h)continue;d=O.y-(R.y+R.h)}
  else continue;
  if(d<0)continue;
  var v=Math.min(R.y+R.h,O.y+O.h)-Math.max(R.y,O.y);
  var hz=Math.min(R.x+R.w,O.x+O.w)-Math.max(R.x,O.x);
  var span=dir==="left"||dir==="right"?v:hz;
  if(span<=0)continue; // same row/column band only
  if(d<bd){bd=d;best=oid}
 }
 return best;
}
/** Would this drop be accepted? Runs moveCard on a copy; true iff it does not refuse. */
function canDrop(tree,kids,state,cfg,dragId,targetId,zone,box){
 var r=moveCard(tree,dragId,targetId,zone,{kids:kids,state:state,cfg:cfg,box:box});
 return r!==null;
}
`;
