/** cockpit-page/win — pure layout: tree -> pixel rects (spec 3.2). Pure ES5 inside a string. */

import type { WinNode } from "./tree.js";

/** The layout entry point the page script mirrors (types here are for the TS side only). */
export type WinBox = { w: number; h?: number };
export type WinState = { min?: number; px?: number; seen?: number };
export type WinCfg = {
  HEAD_H: number;
  GAP: number;
  GUTTER: number;
  minW: number;
  minH?: number;
  defaultH?: number;
  types: { [name: string]: { minW?: number; minH?: number; defaultH?: number } };
};
export type WinRect = { x: number; y: number; w: number; h: number; body: { w: number; h: number } };
export type WinLayoutOut = { rects: { [id: string]: WinRect }; height: number };
export type WinLayout = (
  tree: WinNode | null,
  kids: { [groupId: string]: WinNode | null },
  box: WinBox,
  state: { [id: string]: WinState },
  cfg: WinCfg,
) => WinLayoutOut;

/** layout(tree, kids, box, state, cfg) -> {rects, height}, per spec 3.2. Pure, no DOM.
 *  - box {w} (no h) is the root container: a root column's sz are band px, height is the
 *    sum of the bands; box {w,h} is a bounded container (a group body): a column's sz are
 *    weights of the available height.
 *  - gutters: GAP px between siblings (cfg.GUTTER is the same number; the handle is drawn
 *    inside the gap). A card's body box is its rect minus HEAD_H.
 *  - minimized leaf: HEAD_H tall. In a bounded column the siblings share the rest by weight;
 *    in a root band or a row only the leaf itself shrinks, aligned to the top, the band or
 *    row keeps its size and the space below stays empty. If every card of a root band is
 *    minimized the band shrinks to HEAD_H.
 *  - ghosts (state[id].seen set) take no space: skipped, no rect.
 *  - group recursion: a leaf whose id is in kids lays its kid tree in its body box; kid
 *    rects are relative to the group body.
 *  - narrow mode (render-only): a row whose visible child box would be below that child's
 *    minW is laid out as a column; each child gets its own defaultH (root) or an equal
 *    share (bounded). cfg.minW is the default minW when a type has none. */
export const WIN_LAYOUT_JS = String.raw`function winType(cfg,type){return(cfg.types&&cfg.types[type])||{}}
function winMinW(cfg,type){var t=winType(cfg,type);return t.minW!==undefined?t.minW:cfg.minW}
function winDefH(cfg,type){var t=winType(cfg,type);return t.defaultH!==undefined?t.defaultH:(cfg.defaultH||0)}
function winMin(st,id){var s=st&&st[id];return!!s&&!!s.min}
function winGhost(st,id){var s=st&&st[id];return!!s&&s.seen!==undefined}
function winPx(st,id){var s=st&&st[id];return s&&s.px!==undefined?s.px:null}
/** A leaf's card type: cfg.leafTypes (id -> type, set by the card runtime), else a group for a leaf with kids. */
function winLeafType(kids,id,cfg){var t=cfg&&cfg.leafTypes&&cfg.leafTypes[id];if(t)return t;var k=kids&&kids[id];return k&&k.type?k.type:(k?"group":"leaf")}
/** The least height a node needs at width w: a card its type's minH (a group HEAD_H plus its kids), a row the tallest
 *  child (the sum when narrow mode stacks it), a column enough that every child's weight share holds its need. */
function winNeed(node,w,st,cfg,kids){
 var i,vis=[];
 for(i=0;i<(node.ch||[]).length;i++)if(!winGhost(st,node.ch[i].id))vis.push(node.ch[i]);
 if(node.k==="c"){
  if(winGhost(st,node.id))return 0;
  if(winMin(st,node.id))return cfg.HEAD_H;
  var ty=winType(cfg,winLeafType(kids,node.id,cfg)),mh=ty.minH!==undefined?ty.minH:(cfg.minH||0),kt=kids&&kids[node.id]&&kids[node.id].k?kids[node.id]:null;
  return kt?Math.max(mh,cfg.HEAD_H+winNeed(kt,w,st,cfg,kids)):mh;
 }
 var gap=vis.length>1?cfg.GAP:0,total=w-(vis.length-1)*gap,t=0,need=0,sum=0,k;
 for(i=0;i<node.ch.length;i++)if(!winGhost(st,node.ch[i].id))t+=node.sz[i]||0;
 if(t<=0)t=1;
 if(node.d==="r"){
  var wide=true;
  for(i=0;i<node.ch.length;i++)if(!winGhost(st,node.ch[i].id)&&(node.sz[i]||0)/t*total<winMinW(cfg,winLeafType(kids,node.ch[i].id,cfg)))wide=false;
  for(i=0;i<node.ch.length;i++){
   if(winGhost(st,node.ch[i].id))continue;
   k=winNeed(node.ch[i],wide?(node.sz[i]||0)/t*total:w,st,cfg,kids);
   if(wide)need=Math.max(need,k);else sum+=k+gap;
  }
  return wide?need:Math.max(0,sum-gap);
 }
 for(i=0;i<node.ch.length;i++){
  if(winGhost(st,node.ch[i].id))continue;
  k=winNeed(node.ch[i],w,st,cfg,kids);
  sum+=k;need=Math.max(need,(node.sz[i]||0)>0?k/((node.sz[i]||0)/t):0);
 }
 return Math.max(sum,need)+(vis.length-1)*gap;
}
/** Content-driven height (auto layout only: cfg.fit = {id: card px} measured by the runtime): a card its measured height, a
 *  group HEAD_H plus its kids, a row the tallest child, a column the sum. null when any card in it has no reading (keep the default). */
function winFit(node,w,st,cfg,kids){
 var i,vis=[],k;
 for(i=0;i<(node.ch||[]).length;i++)if(!winGhost(st,node.ch[i].id))vis.push(i);
 if(node.k==="c"){
  if(winGhost(st,node.id))return 0;
  if(winMin(st,node.id))return cfg.HEAD_H;
  var kt=kids&&kids[node.id]&&kids[node.id].k?kids[node.id]:null;
  if(kt){k=winFit(kt,w,st,cfg,kids);return k===null?null:cfg.HEAD_H+k}
  if(winPx(st,node.id)!==null)return null;
  var v=cfg.fit[node.id];
  return v===undefined?null:Math.max(v,winNeed(node,w,st,cfg,kids));
 }
 var gap=vis.length>1?cfg.GAP:0,total=w-(vis.length-1)*gap,t=0,r=0,sum=0;
 for(i=0;i<vis.length;i++)t+=node.sz[vis[i]]||0;
 if(t<=0)t=1;
 var wide=node.d==="r";
 if(wide)for(i=0;i<vis.length;i++)if((node.sz[vis[i]]||0)/t*total<winMinW(cfg,winLeafType(kids,node.ch[vis[i]].id,cfg)))wide=false;
 for(i=0;i<vis.length;i++){
  k=winFit(node.ch[vis[i]],node.d==="r"&&wide?(node.sz[vis[i]]||0)/t*total:w,st,cfg,kids);
  if(k===null)return null;
  r=Math.max(r,k);sum+=k;
 }
 return node.d==="r"&&wide?r:sum+(vis.length-1)*gap;
}
/** Lay out one split into pieces {n,x,y,w,h}. bounded: the container has a fixed h. */
function winSplit(node,box,bounded,st,cfg,kids){
 var n=node.ch.length,i,out=[];
 // ghosts take no space: gutters and weights are over the visible children only
 var vis=[];for(i=0;i<n;i++)if(!winGhost(st,node.ch[i].id))vis.push(i);
 var gap=vis.length>1?cfg.GAP:0,total=box.w-(vis.length-1)*gap;
 if(node.d==="r"){
  var t=0;for(i=0;i<vis.length;i++)t+=node.sz[vis[i]]||0;if(t<=0)t=1;
  var ws=[];
  for(i=0;i<node.sz.length;i++){
   ws.push(node.sz[i]/t*total);
  }
  var wide=true;
  for(i=0;i<vis.length;i++)if(ws[vis[i]]<winMinW(cfg,winLeafType(kids,node.ch[vis[i]].id,cfg)))wide=false;
  if(!wide){
   // narrow mode: stack; root gives each child its defaultH, bounded an equal share
   var h0=bounded?Math.max(0,(box.h-(vis.length-1)*gap)/vis.length):0;
   var y=0;
   for(i=0;i<vis.length;i++){
    var c=node.ch[vis[i]];
    var hh=winMin(st,c.id)?cfg.HEAD_H:(bounded?Math.max(h0,winNeed(c,box.w,st,cfg,kids)):winDefH(cfg,winLeafType(kids,c.id,cfg)));
    out.push({n:c,x:0,y:y,w:box.w,h:hh});
    y+=hh+gap;
   }
   return out;
  }
  var x=0;
  for(i=0;i<vis.length;i++){
   var ci=vis[i],w=ws[ci],ch=node.ch[ci];
   // a row with a fixed height (band cell, bounded container): children fill it;
   // a bare root row has no height of its own: children get their defaultH
   var hh2=winMin(st,ch.id)?cfg.HEAD_H:(box.h>0?box.h:winDefH(cfg,winLeafType(kids,ch.id,cfg)));
   out.push({n:ch,x:x,y:0,w:w,h:hh2});
   x+=w+gap;
  }
  return out;
 }
 // column
 if(bounded){
  var rest=box.h-(vis.length-1)*gap,m=0,t2=0;
  for(i=0;i<vis.length;i++){
   if(winMin(st,node.ch[vis[i]].id))m+=cfg.HEAD_H;else t2+=node.sz[vis[i]]||0;
  }
  var avail=rest-m;if(avail<0)avail=0;
  // auto layout: every card takes its content height when they all fit the box; else the weights
  var fh=null;
  if(cfg.fit){
   var fs=[],fsum=0;
   for(i=0;i<vis.length&&fs;i++){
    var fv=winMin(st,node.ch[vis[i]].id)?0:winFit(node.ch[vis[i]],box.w,st,cfg,kids);
    if(fv===null)fs=null;else{fs.push(fv);fsum+=fv}
   }
   if(fs&&fsum<=avail+0.5)fh=fs;
  }
  var y2=0;
  for(i=0;i<vis.length;i++){
   var c2=node.ch[vis[i]],h2;
   if(winMin(st,c2.id))h2=cfg.HEAD_H;
   else if(fh)h2=fh[i];
   else h2=t2>0?(node.sz[vis[i]]||0)/t2*avail:avail/Math.max(1,vis.length);
   out.push({n:c2,x:0,y:y2,w:box.w,h:h2});
   y2+=h2+gap;
  }
  return out;
 }
 // root bands: sz are px
 var y3=0,si=0;
 // si walks sz in child order; ghosts consume their sz slot but add no height
 for(i=0;i<n;i++){
  var sz=node.sz[si]||0;si++;
  if(winGhost(st,node.ch[i].id))continue;
  var c3=node.ch[i];
  // auto layout: a default band shrinks to its content (never above its default px, never below its types' minH)
  if(cfg.fit){var fb=winFit(c3,box.w,st,cfg,kids);if(fb!==null)sz=Math.max(fb,winNeed(c3,box.w,st,cfg,kids))}
  var h3;
  if(c3.k==="s"){
   var allMin=true,any=false;
   for(var q=0;q<c3.ch.length;q++)if(!winGhost(st,c3.ch[q].id)){any=true;if(!winMin(st,c3.ch[q].id))allMin=false}
   // a band with no visible card takes no space; all visible minimized shrinks to HEAD_H
   if(allMin&&any){
    // every visible card of the band is minimized: the band shrinks to HEAD_H;
    // the headers go through the normal split, which gives each one HEAD_H
    h3=cfg.HEAD_H;
    var sub0=winSplit(c3,{w:box.w,h:cfg.HEAD_H},false,st,cfg,kids);
    for(var q2=0;q2<sub0.length;q2++)
     out.push({n:sub0[q2].n,x:sub0[q2].x,y:y3+sub0[q2].y,w:sub0[q2].w,h:sub0[q2].h});
   }else if(!any){
    // a band with no visible card takes no space (spec 3.4: ghosts are skipped)
    continue;
   }else{
    var sub=winSplit(c3,{w:box.w,h:sz},false,st,cfg,kids);
    var maxB=0;
    for(var j=0;j<sub.length;j++){
     out.push({n:sub[j].n,x:sub[j].x,y:y3+sub[j].y,w:sub[j].w,h:sub[j].h});
     if(sub[j].y+sub[j].h>maxB)maxB=sub[j].y+sub[j].h;
    }
    // the band grows to max(px, content) when the stacked content is taller (narrow mode);
    // the next band starts below the content, never on top of it
    h3=Math.max(sz,maxB);
   }
  }else{
   h3=winMin(st,c3.id)?cfg.HEAD_H:Math.max(winPx(st,c3.id)!==null?winPx(st,c3.id):sz,winNeed(c3,box.w,st,cfg,kids));
   out.push({n:c3,x:0,y:y3,w:box.w,h:h3});
  }
  y3+=h3+gap;
 }
 return out;
}
function layout(tree,kids,box,state,cfg){
 var rects={},height=0;
 if(!tree||box.w<=0)return{rects:rects,height:0};
 // only the root container is unbounded: its column holds band px. Everything below
 // (group bodies, nested splits) is bounded and lays columns by weight.
 var root=box.h===undefined;
 // a bare root leaf (the whole tree is one card) gets its type's defaultH, not 0
 var h0=root?(tree.k==="c"?winDefH(cfg,winLeafType(kids,tree.id,cfg)):0):box.h;
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
    // bounded: the group body has a fixed box, so its columns lay out by weight
    var r=layout(kt,kids,{w:it.w,h:Math.max(0,h-cfg.HEAD_H)},state,cfg);
    for(var g in r.rects)rects[g]=r.rects[g];
   }
   continue;
  }
  if(guard++>10000)continue;
  var ch=winSplit(n,{w:it.w,h:it.h},it.bounded,state,cfg,kids);
  for(var i=0;i<ch.length;i++){
   var c=ch[i];
   // a split cell always has a fixed height (band px or the bounded box), so below the
   // root every split lays its column by weight
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
`;
