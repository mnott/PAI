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
 *  (remove + normalize, insert by zone, normalize), or null when the resulting box of any
 *  card would be below its minW/minH (refusal; narrow mode never refuses a row split).
 *  neighbor(rects,id,dir) -> the id of the nearest visible card in that direction, or null.
 *  canDrop(tree,kids,state,cfg,dragId,targetId,zone,box) -> true|false: the drop runs on a
 *  copy and is refused exactly as moveCard would refuse it.
 *  A drop that yields the identical tree returns the tree unchanged (no-op).
 *  No backticks inside the string: the tests extract it up to the closing one. */
export const WIN_DROP_JS = String.raw`function leaf(id){return{k:"c",id:String(id)}}
function split(d,ch,sz){return{k:"s",d:d==="c"?"c":"r",ch:ch||[],sz:sz||[]}}
function winType(cfg,type){return(cfg.types&&cfg.types[type])||{}}
function winMinW(cfg,type){var t=winType(cfg,type);return t.minW!==undefined?t.minW:cfg.minW}
function winMinH(cfg,type){var t=winType(cfg,type);return t.minH!==undefined?t.minH:cfg.minH||0}
function winDefH(cfg,type){var t=winType(cfg,type);return t.defaultH!==undefined?t.defaultH:(cfg.defaultH||0)}
function winMin(st,id){var s=st&&st[id];return!!s&&!!s.min}
function winGhost(st,id){var s=st&&st[id];return!!s&&s.seen!==undefined}
function winPx(st,id){var s=st&&st[id];return s&&s.px!==undefined?s.px:null}
function winLeafType(kids,id){var k=kids&&kids[id];return k&&k.type?k.type:(k?"group":"leaf")}
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
/** The leaf with this id, or null. */
function findLeaf(tree,id){
 if(!tree)return null;
 if(tree.k==="c")return tree.id===id?tree:null;
 for(var i=0;i<tree.ch.length;i++){var r=findLeaf(tree.ch[i],id);if(r)return r}
 return null;
}
/** The Split that directly holds the leaf, or null (the root leaf has no parent). */
function parentOf(tree,id){
 if(!tree||tree.k!=="s")return null;
 for(var i=0;i<tree.ch.length;i++){
  var c=tree.ch[i];
  if(c.k==="c"&&c.id===id)return tree;
  var r=parentOf(c,id);if(r)return r;
 }
 return null;
}
/** The Split that directly holds node n (n is a child of tree), or null. */
function parentOfNode(tree,n){
 if(!tree||tree.k!=="s")return null;
 for(var i=0;i<tree.ch.length;i++){
  if(tree.ch[i]===n)return tree;
  var r=parentOfNode(tree.ch[i],n);if(r)return r;
 }
 return null;
}
/** Leaf ids in reading order. */
function ids(tree){
 var out=[];
 if(!tree)return out;
 if(tree.k==="c"){out.push(tree.id);return out}
 for(var i=0;i<tree.ch.length;i++)out=out.concat(ids(tree.ch[i]));
 return out;
}
function isSplit(n){return!!n&&n.k==="s"}
/** Bottom-up normalize (same contract as win/tree.ts): merge same-direction nesting with
 *  multiplied weights, drop non-positive weights, collapse a one-child split, renorm.
 *  isRoot marks the top node of the page tree: a root column holds band px, left alone. */
/** isRoot: true = this node is the page root (its column holds band px);
 *  false = a bounded split (its column holds weights). Children always normalize as
 *  bounded: a nested column (below a row) holds weights; a band split that collapses to
 *  a bare leaf keeps its band px because layout reads the band's own sz slot, not the
 *  leaf's node. */
function normalize(node,isRoot){
 if(!isSplit(node))return node;
 var ch=[],sz=[],i;
 var childRoot=isRoot&&node.d==="c"; // children of the root column are root-aware
 for(i=0;i<node.ch.length;i++){
  var c=normalize(node.ch[i],childRoot);
  if(isSplit(c)&&c.d===node.d){
   var w=node.sz[i]||0;
   for(var j=0;j<c.ch.length;j++){ch.push(c.ch[j]);sz.push(w*(c.sz[j]||0))}
  }else{ch.push(c);sz.push(node.sz[i])}
 }
 node.ch=ch;node.sz=sz;
 var keep=[],ks=[];
 for(i=0;i<ch.length;i++)if(!(sz[i]<=0)){keep.push(ch[i]);ks.push(sz[i])}
 node.ch=keep;node.sz=ks;
 if(node.ch.length===1)return node.ch[0];
 if(node.ch.length===0)return null;
 renorm(node,isRoot===true);
 return node;
}
function renorm(node,isRoot){
 // only the root column itself (the top node) holds band px; nested columns hold weights
 if(isRoot===true&&node.d==="c")return node;
 var t=0,i;for(i=0;i<node.sz.length;i++)t+=node.sz[i];
 if(t<=0)return node;
 for(i=0;i<node.sz.length;i++)node.sz[i]=node.sz[i]/t;
 return node;
}
/** Remove the leaf (mutates in place), then normalize. isRoot passes through (default true). */
/** Remove the leaf (mutates in place), then normalize. isRoot passes through (default true).
 *  A band split that collapses to a bare leaf keeps its px: the split is returned holding
 *  the leaf (a root column holds band px; layout reads the band's own sz slot), so the
 *  band does not shrink to a weight. */
function removeLeaf(tree,id,isRoot){
 if(!tree)return null;
 if(tree.k==="c")return tree.id===id?null:tree;
 for(var i=0;i<tree.ch.length;i++){
  var c=tree.ch[i];
  if(c.k==="c"){if(c.id===id){tree.ch.splice(i,1);tree.sz.splice(i,1);break}}
  else if(findLeaf(c,id)){tree.ch[i]=removeLeaf(c,id,isRoot&&tree.d==="c");break}
 }
 // a collapsed band keeps its px slot: return the split holding the leaf, not the leaf
 if(tree.ch.length===1&&tree.sz.length===1&&tree.ch[0].k==="c"&&isRoot===true&&tree.d==="c")return tree;
 return normalize(tree,isRoot===undefined?true:isRoot);
}
/** Lay out one split into pieces {n,x,y,w,h}. Same geometry as win/layout.ts winSplit
 *  (ghosts skipped, weights over visible children, narrow mode stacks). */
function winSplit(node,box,bounded,st,cfg,kids){
 var n=node.ch.length,i,out=[];
 var vis=[];for(i=0;i<n;i++)if(!winGhost(st,node.ch[i].id))vis.push(i);
 var gap=vis.length>1?cfg.GAP:0,total=box.w-(vis.length-1)*gap;
 if(node.d==="r"){
  var t=0;for(i=0;i<vis.length;i++)t+=node.sz[vis[i]]||0;if(t<=0)t=1;
  var ws=[];
  for(i=0;i<node.sz.length;i++)ws.push(node.sz[i]/t*total);
  var wide=true;
  for(i=0;i<vis.length;i++)if(ws[vis[i]]<winMinW(cfg,winLeafType(kids,node.ch[vis[i]].id)))wide=false;
  if(!wide){
   var h0=bounded?Math.max(0,(box.h-(vis.length-1)*gap)/vis.length):0;
   var y=0;
   for(i=0;i<vis.length;i++){
    var c=node.ch[vis[i]];
    var hh=winMin(st,c.id)?cfg.HEAD_H:(bounded?h0:winDefH(cfg,winLeafType(kids,c.id)));
    out.push({n:c,x:0,y:y,w:box.w,h:hh});
    y+=hh+gap;
   }
   return out;
  }
  var x=0;
  for(i=0;i<vis.length;i++){
   var ci=vis[i],w=ws[ci],ch=node.ch[ci];
   var hh2=winMin(st,ch.id)?cfg.HEAD_H:(box.h>0?box.h:winDefH(cfg,winLeafType(kids,ch.id)));
   out.push({n:ch,x:x,y:0,w:w,h:hh2});
   x+=w+gap;
  }
  return out;
 }
 if(bounded){
  var rest=box.h-(vis.length-1)*gap,m=0,t2=0;
  for(i=0;i<vis.length;i++){
   if(winMin(st,node.ch[vis[i]].id))m+=cfg.HEAD_H;else t2+=node.sz[vis[i]]||0;
  }
  var avail=rest-m;if(avail<0)avail=0;
  var y2=0;
  for(i=0;i<vis.length;i++){
   var c2=node.ch[vis[i]],h2;
   if(winMin(st,c2.id))h2=cfg.HEAD_H;
   else h2=t2>0?(node.sz[vis[i]]||0)/t2*avail:avail/Math.max(1,vis.length);
   out.push({n:c2,x:0,y:y2,w:box.w,h:h2});
   y2+=h2+gap;
  }
  return out;
 }
 var y3=0,si=0;
 for(i=0;i<n;i++){
  var sz=node.sz[si]||0;si++;
  if(winGhost(st,node.ch[i].id))continue;
  var c3=node.ch[i];
  var h3;
  if(c3.k==="s"){
   var allMin=true,any=false;
   for(var q=0;q<c3.ch.length;q++)if(!winGhost(st,c3.ch[q].id)){any=true;if(!winMin(st,c3.ch[q].id))allMin=false}
   if(allMin&&any){
    h3=cfg.HEAD_H;
    var sub0=winSplit(c3,{w:box.w,h:cfg.HEAD_H},false,st,cfg,kids);
    for(var q2=0;q2<sub0.length;q2++)
     out.push({n:sub0[q2].n,x:sub0[q2].x,y:y3+sub0[q2].y,w:sub0[q2].w,h:sub0[q2].h});
   }else if(!any){
    continue; // a band with no visible card takes no space
   }else{
    var sub=winSplit(c3,{w:box.w,h:sz},false,st,cfg,kids);
    var maxB=0;
    for(var j=0;j<sub.length;j++){
     out.push({n:sub[j].n,x:sub[j].x,y:y3+sub[j].y,w:sub[j].w,h:sub[j].h});
     if(sub[j].y+sub[j].h>maxB)maxB=sub[j].y+sub[j].h;
    }
    h3=Math.max(sz,maxB);
   }
  }else{
   h3=winMin(st,c3.id)?cfg.HEAD_H:(winPx(st,c3.id)!==null?winPx(st,c3.id):sz);
   out.push({n:c3,x:0,y:y3,w:box.w,h:h3});
  }
  y3+=h3+gap;
 }
 return out;
}
/** layout(tree,kids,box,state,cfg) -> {rects,height}. Same contract as win/layout.ts. */
function layout(tree,kids,box,state,cfg){
 var rects={},height=0;
 if(!tree||box.w<=0)return{rects:rects,height:0};
 var root=box.h===undefined;
 var h0=root?(tree.k==="c"?winDefH(cfg,winLeafType(kids,tree.id)):0):box.h;
 var out=[{n:tree,x:0,y:0,w:box.w,h:h0,bounded:!root}];
 var guard=0;
 while(out.length){
  var it=out.pop(),n=it.n;
  if(n.k==="c"){
   if(winGhost(state,n.id))continue;
   var min=winMin(state,n.id);
   var h=min?cfg.HEAD_H:it.h;
   rects[n.id]={x:it.x,y:it.y,w:it.w,h:h,body:{w:it.w,h:Math.max(0,h-cfg.HEAD_H)}};
   var kt=kids&&kids[n.id]&&kids[n.id].k?kids[n.id]:null;
   if(kt&&!min){
    var r=layout(kt,kids,{w:it.w,h:Math.max(0,h-cfg.HEAD_H)},state,cfg);
    for(var g in r.rects)rects[g]=r.rects[g];
   }
   continue;
  }
  if(guard++>10000)continue;
  var ch=winSplit(n,{w:it.w,h:it.h},it.bounded,state,cfg,kids);
  for(var i=0;i<ch.length;i++){
   var c=ch[i];
   out.push({n:c.n,x:it.x+c.x,y:it.y+c.y,w:c.w,h:c.h,bounded:true});
  }
 }
 if(root){
  var max=0,id;
  for(id in rects)if(rects[id].y+rects[id].h>max)max=rects[id].y+rects[id].h;
  height=max;
 }else height=box.h;
 return{rects:rects,height:height};
}
/** Refuse when the resulting box of any card is below its minW/minH (spec 3.3).
 *  A row that stacks in narrow mode is not refused (the split stacks, not shrinks). */
function winFits(tree,kids,state,cfg,box){
 var r=layout(tree,kids,box,state,cfg);
 for(var id in r.rects){
  var rc=r.rects[id],tp=winLeafType(kids,id);
  var mw=winMinW(cfg,tp),mh=winMinH(cfg,tp);
  var rowStack=false;
  var P=parentOf(tree,id);
  if(P&&P.d==="r"){
   var t=0,vis=0;
   for(var i=0;i<P.ch.length;i++)if(!winGhost(state,P.ch[i].id)){t+=P.sz[i]||0;vis++}
   if(t>0&&vis>1&&(P.sz[0]/t)*(box.w-(vis-1)*cfg.GAP)<winMinW(cfg,winLeafType(kids,P.ch[0].id)))rowStack=true;
  }
  if(!rowStack&&(rc.w<mw||rc.h<mh))return false;
 }
 return true;
}
/** The drop result per 3.3, or null on refusal. Mutates a clone; the input tree is untouched.
 *  opts: {kids,state,cfg,box} — box is the container box used for the min-size refusal
 *  (default {w:10000,h:10000}: nothing refuses without a box). */
function moveCard(tree,dragId,targetId,zone,opts){
 opts=opts||{};
 var kids=opts.kids||{},st=opts.state||{},cfg=opts.cfg||{HEAD_H:28,GAP:8,minW:220,types:{}};
 var box=opts.box||{w:10000,h:10000};
 if(!tree||dragId===targetId||zone==="none")return null;
 if(!findLeaf(tree,dragId)||!findLeaf(tree,targetId))return null;
 var t=winClone(tree);
 // 1. remove D, normalize (root band px kept; a band emptied by removal is gone)
 t=removeLeaf(t,dragId,true);
 // 2. T's parent after removal
 var P=parentOf(t,targetId);
 var T=findLeaf(t,targetId);
 if(!T)return null;
 var dH=winDefH(cfg,winLeafType(kids,dragId));
 var px=winPx(st,dragId);
 var ins=function(arr,sz,i,node,w){arr.splice(i,0,node);sz.splice(i,0,w)};
 if(zone==="left"||zone==="right"){
  var at=zone==="right"?1:0;
  if(P&&P.d==="r"){
   var i=P.ch.indexOf(T);
   ins(P.ch,P.sz,i+at,leaf(dragId),(P.sz[i]||0)/2);
   P.sz[i]=(P.sz[i]||0)/2;
  }else{
   // T is in a column or is the root leaf: a new row [D,T] or [T,D], 0.5/0.5
   var row=split("r",[zone==="right"?leaf(targetId):leaf(dragId),zone==="right"?leaf(dragId):leaf(targetId)],[0.5,0.5]);
   if(!P){t=row}
   else{var j=P.ch.indexOf(T);P.ch[j]=row}
  }
 }else{ // top | bottom
  var at2=zone==="bottom"?1:0;
  if(P&&P.d==="c"){
   var k=P.ch.indexOf(T);
   var w=P.sz[k]||0;
   if(box.h===undefined){
    // root: D gets a new band of its remembered px or its defaultH next to T's band;
    // T's band keeps its px
    ins(P.ch,P.sz,k+at2,leaf(dragId),px!==null?px:dH);
   }else{
    // bounded: halves T's weight
    ins(P.ch,P.sz,k+at2,leaf(dragId),w/2);
    P.sz[k]=w/2;
   }
  }else{
   // T is in a row (or is the root leaf): a new column [D,T]/[T,D], 0.5/0.5 weights
   var col=split("c",[zone==="bottom"?leaf(targetId):leaf(dragId),zone==="bottom"?leaf(dragId):leaf(targetId)],[0.5,0.5]);
   if(!P){t=col}
   else{var m=P.ch.indexOf(T);P.ch[m]=col}
  }
 }
 // 5. normalize
 t=normalize(t,true);
 // refusal: any resulting box below minW/minH (narrow-stacked rows are fine)
 if(!winFits(t,kids,st,cfg,box))return null;
 // no-op: the identical tree comes back unchanged
 var same=function(a,b){
  if(a===b)return true;
  if(!a||!b)return a===b;
  if(a.k!==b.k)return false;
  if(a.k==="c")return a.id===b.id;
  if(a.d!==b.d||a.ch.length!==b.ch.length)return false;
  for(var i=0;i<a.ch.length;i++)if(a.sz[i]!==b.sz[i]||!same(a.ch[i],b.ch[i]))return false;
  return true;
 };
 if(same(tree,t))return tree;
 return t;
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
