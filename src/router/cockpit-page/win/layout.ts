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
 *  - dock: cfg.dock = {group id: [minimized ids]} (the runtime makes those ghosts in state): they get chip rects ({chip:1}, cfg.CHIP_H tall)
 *    in rows at the bottom of the group body; the group's kids lay out above, in the rest.
 *  - ghosts (state[id].seen set) take no space: skipped, no rect.
 *  - group recursion: a leaf whose id is in kids lays its kid tree in its body box; kid
 *    rects are relative to the group body.
 *  - narrow mode (render-only): a row whose visible child box would be below that child's
 *    minW is laid out as a column; each child gets its own defaultH (root) or an equal
 *    share (bounded). cfg.minW is the default minW when a type has none. */
export const WIN_LAYOUT_JS = String.raw`function winType(cfg,type){return(cfg.types&&cfg.types[type])||{}}
function winMinW(cfg,type){var t=winType(cfg,type);return t.minW!==undefined?t.minW:cfg.minW}
function winDefH(cfg,type){var t=winType(cfg,type);return t.defaultH!==undefined?t.defaultH:(cfg.defaultH||0)}
function winMin(st,id){var s=st&&st[id];return!!s&&s.min===1}
function winGhost(st,id){var s=st&&st[id];return!!s&&s.seen!==undefined}
function winPx(st,id){var s=st&&st[id];return s&&s.px!==undefined?s.px:null}
/** The user's height (st[id].h, set by a card's height handle) of a node, floored at its type's minH and the header: a leaf its own, a row the tallest of its children's (the line takes the height the user set), a column or group none (null). */
function winUH(node,st,cfg,kids){
 var i,m=null,k;
 if(node.k==="c"){
  var s=st&&st[node.id];
  if(!s||s.h===undefined||s.min===1||s.seen!==undefined||(kids&&kids[node.id]&&kids[node.id].k))return null;
  var ty=winType(cfg,winLeafType(kids,node.id,cfg));
  return Math.max(s.h,ty.minH!==undefined?ty.minH:(cfg.minH||0),cfg.HEAD_H);
 }
 if(node.d!=="r")return null;
 for(i=0;i<node.ch.length;i++)if(!winGhost(st,node.ch[i].id)){k=winUH(node.ch[i],st,cfg,kids);if(k!==null&&(m===null||k>m))m=k}
 return m;
}
/** Stacked mode of the auto layout: the box is under cfg.narrowW wide, so heights follow content, not weights or band px. */
function winNar(cfg,w){return!!cfg.fit&&!!cfg.narrowW&&w<cfg.narrowW}
/** A leaf's card type: cfg.leafTypes (id -> type, set by the card runtime), else a group for a leaf with kids. */
function winLeafType(kids,id,cfg){var t=cfg&&cfg.leafTypes&&cfg.leafTypes[id];if(t)return t;var k=kids&&kids[id];return k&&k.type?k.type:(k?"group":"leaf")}
/** A card's least width in a grid: its type's minW, or its title's text width plus header controls (cfg.titleW, measured by the runtime) when that is wider, capped at 1.6 x minW (a longer title keeps its ellipsis). */
function winCardMinW(cfg,kids,id){var m=winMinW(cfg,winLeafType(kids,id,cfg)),t=cfg.titleW&&cfg.titleW[id];return t&&t>m?Math.min(t,Math.round(m*1.6)):m}
/** A card's width share inside its row: st[id].sp is the divisor (4 = 1/4, 3 = 1/3, 2 = 1/2, 1 = the whole row), absent = auto (its weight). */
function winSp(st,id){var s=st&&st[id];return s&&s.sp>0?s.sp:0}
/** Row flow: when a visible child of the row has a width share, the children are laid in lines of the row width: a share
 *  card takes that fraction (1 = its own line), an auto card its weight share of what its line has left. A card whose width
 *  falls under its least width goes on its own line. Returns null without any share, else {lines:[[{i,x,w}]]} (i = index in node.ch). */
function winFlow(node,w,st,cfg,kids){
 var i,vis=[],any=false,t=0,gap=cfg.GAP,lines=[],cur=[],fr=0,ln,j;
 for(i=0;i<node.ch.length;i++)if(!winGhost(st,node.ch[i].id)){vis.push(i);t+=node.sz[i]||0;if(winSp(st,node.ch[i].id))any=true}
 if(!any)return null;
 if(t<=0)t=1;
 var f=[];
 for(j=0;j<vis.length;j++){
  var id=node.ch[vis[j]].id,sp=winSp(st,id),x=sp?1/sp:(node.sz[vis[j]]||0)/t;
  if(x<1&&(sp?x*(w+gap)-gap:x*(w-(vis.length-1)*gap))<winCardMinW(cfg,kids,id))x=1;
  f.push(x);
 }
 for(j=0;j<vis.length;j++){
  if(cur.length&&fr+f[j]>1.0001){lines.push(cur);cur=[];fr=0}
  cur.push(j);fr+=f[j];
  if(f[j]>=1){lines.push(cur);cur=[];fr=0}
 }
 if(cur.length)lines.push(cur);
 var out=[];
 for(i=0;i<lines.length;i++){
  ln=lines[i];var used=0,aw=0,m=ln.length,res=[],x0=0;
  for(j=0;j<m;j++){var q=ln[j],qid=node.ch[vis[q]].id;if(winSp(st,qid)||f[q]>=1)used+=f[q]>=1?w:f[q]*(w+gap)-gap;else aw+=node.sz[vis[q]]||0}
  var rest=w-used-(m-1)*gap;
  for(j=0;j<m;j++){
   var p=ln[j],pid=node.ch[vis[p]].id,pw;
   if(f[p]>=1)pw=w;else if(winSp(st,pid))pw=f[p]*(w+gap)-gap;else pw=aw>0?rest*(node.sz[vis[p]]||0)/aw:0;
   res.push({i:vis[p],x:x0,w:pw});x0+=pw+gap;
  }
  out.push(res);
 }
 return{lines:out};
}
/** Narrow row: children per line and their equal width. At most as many as fit at the largest least width; the lines are balanced:
 *  lines = ceil(n / kMax), per line = ceil(n / lines), so earlier lines are never shorter than later ones. */
function winGridK(node,w,st,cfg,kids){
 var i,n=0,m=0,gap=cfg.GAP,k,kmax;
 for(i=0;i<node.ch.length;i++)if(!winGhost(st,node.ch[i].id)){n++;m=Math.max(m,winCardMinW(cfg,kids,node.ch[i].id))}
 kmax=Math.max(1,Math.min(n,Math.floor((w+gap)/(m+gap))));
 k=n>0?Math.ceil(n/Math.ceil(n/kmax)):1;
 return{k:k,cw:(w-(k-1)*gap)/k};
}
/** The dock of a group: its minimized cards (cfg.dock = {group id: [ids]}) as title chips in rows at the bottom of the group body, in tree order, wrapping at width w.
 *  Returns {r:[{id,x,y,w,h}], h: dock height, 0 for none}; cfg.chipW = {id: chip px}. */
function winDock(cfg,gid,w){
 var d=cfg.dock&&cfg.dock[gid],r=[],x=0,y=0,i,cw,ch=cfg.CHIP_H||22;
 if(!d||!d.length)return{r:r,h:0};
 for(i=0;i<d.length;i++){
  cw=Math.min(w,(cfg.chipW&&cfg.chipW[d[i]])||120);
  if(x>0&&x+cw>w){x=0;y+=ch+4}
  r.push({id:d[i],x:x,y:y,w:cw,h:ch});x+=cw+4;
 }
 return{r:r,h:y+ch};
}
/** Room a group's dock takes below its kids (the dock and the gap above it), 0 without chips. */
function winDockH(cfg,gid,w){var h=winDock(cfg,gid,w).h;return h?h+cfg.GAP:0}
/** The one visible child of a group's kid tree when it is itself an unminimized group (leaf id), else null: that child's header is not drawn (its cards fill the parent body). */
function winSolo(kt,st,kids){
 var ids=[];
 (function walk(n){if(n.k==="c"){if(!winGhost(st,n.id))ids.push(n.id)}else for(var i=0;i<n.ch.length;i++)walk(n.ch[i])})(kt);
 return ids.length===1&&!winMin(st,ids[0])&&kids[ids[0]]&&kids[ids[0]].k?ids[0]:null;
}
/** The least height a node needs at width w (flat: a fitted band, whose cards take their content height, not a weight share; a column needs only the sum of its cards): a card its type's minH (a group HEAD_H plus its kids), a row the tallest
 *  child (the sum when narrow mode stacks it), a column enough that every child's weight share holds its need. */
function winNeed(node,w,st,cfg,kids,flat){
 var i,vis=[];
 for(i=0;i<(node.ch||[]).length;i++)if(!winGhost(st,node.ch[i].id))vis.push(node.ch[i]);
 if(node.k==="c"){
  if(winGhost(st,node.id))return 0;
  if(winMin(st,node.id))return cfg.HEAD_H;
  var ty=winType(cfg,winLeafType(kids,node.id,cfg)),mh=ty.minH!==undefined?ty.minH:(cfg.minH||0),kt=kids&&kids[node.id]&&kids[node.id].k?kids[node.id]:null;
  return kt?Math.max(mh,cfg.HEAD_H+winNeed(kt,w,st,cfg,kids,flat)-(winSolo(kt,st,kids)?cfg.HEAD_H:0)+winDockH(cfg,node.id,w)):mh;
 }
 var gap=vis.length>1?cfg.GAP:0,total=w-(vis.length-1)*gap,t=0,need=0,sum=0,k;
 for(i=0;i<node.ch.length;i++)if(!winGhost(st,node.ch[i].id))t+=node.sz[i]||0;
 if(t<=0)t=1;
 if(node.d==="r"){
  var fl=winFlow(node,w,st,cfg,kids);
  if(fl){
   for(var li=0;li<fl.lines.length;li++){var lm=0;for(var lj=0;lj<fl.lines[li].length;lj++){var it=fl.lines[li][lj];lm=Math.max(lm,winNeed(node.ch[it.i],it.w,st,cfg,kids,flat))}sum+=lm+gap}
   return Math.max(0,sum-gap);
  }
  var wide=true,g=null,ln=0,lc=0;
  for(i=0;i<node.ch.length;i++)if(!winGhost(st,node.ch[i].id)&&(node.sz[i]||0)/t*total<winCardMinW(cfg,kids,node.ch[i].id))wide=false;
  if(!wide)g=winGridK(node,w,st,cfg,kids);
  for(i=0;i<node.ch.length;i++){
   if(winGhost(st,node.ch[i].id))continue;
   k=winNeed(node.ch[i],wide?(node.sz[i]||0)/t*total:g.cw,st,cfg,kids,flat);
   if(wide)need=Math.max(need,k);
   else{ln=Math.max(ln,k);if(++lc===g.k){sum+=ln+gap;ln=0;lc=0}}
  }
  if(!wide&&lc>0)sum+=ln+gap;
  return wide?need:Math.max(0,sum-gap);
 }
 for(i=0;i<node.ch.length;i++){
  if(winGhost(st,node.ch[i].id))continue;
  k=winNeed(node.ch[i],w,st,cfg,kids,flat);
  var uk=winUH(node.ch[i],st,cfg,kids);if(uk!==null&&uk>k)k=uk;
  sum+=k;need=Math.max(need,(node.sz[i]||0)>0?k/((node.sz[i]||0)/t):0);
 }
 return(flat||winNar(cfg,w)?sum:Math.max(sum,need))+(vis.length-1)*gap;
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
  if(kt){k=winFit(kt,w,st,cfg,kids);return k===null?null:cfg.HEAD_H+k-(winSolo(kt,st,kids)?cfg.HEAD_H:0)+winDockH(cfg,node.id,w)}
  var uh=winUH(node,st,cfg,kids);
  if(uh!==null)return uh;
  if(winPx(st,node.id)!==null)return null;
  var v=cfg.fit[node.id],nar=winNar(cfg,w);
  // stacked: a chart (draws at the body size) takes an aspect of its width, any other card without a reading its least height
  if(nar&&winLeafType(kids,node.id,cfg)==="chart")return Math.max(winNeed(node,w,st,cfg,kids),Math.round(w*0.45)+cfg.HEAD_H);
  if(nar&&v===undefined)return winNeed(node,w,st,cfg,kids);
  return v===undefined?null:Math.max(v,winNeed(node,w,st,cfg,kids));
 }
 var gap=vis.length>1?cfg.GAP:0,total=w-(vis.length-1)*gap,t=0,r=0,sum=0,ln=0,lc=0;
 for(i=0;i<vis.length;i++)t+=node.sz[vis[i]]||0;
 if(t<=0)t=1;
 var wide=node.d==="r",g=null;
 var fl=node.d==="r"?winFlow(node,w,st,cfg,kids):null;
 if(fl){
  for(var li=0;li<fl.lines.length;li++){
   var lm=0,lun=0;
   for(var lj=0;lj<fl.lines[li].length;lj++){
    var it=fl.lines[li][lj];k=winFit(node.ch[it.i],it.w,st,cfg,kids);
    if(k===null)return null;
    lm=Math.max(lm,k);var iu=winUH(node.ch[it.i],st,cfg,kids);if(iu!==null)lun=Math.max(lun,iu);
   }
   sum+=(lun>0?lun:lm)+gap;
  }
  return Math.max(0,sum-gap);
 }
 if(wide)for(i=0;i<vis.length;i++)if((node.sz[vis[i]]||0)/t*total<winCardMinW(cfg,kids,node.ch[vis[i]].id))wide=false;
 if(node.d==="r"&&!wide)g=winGridK(node,w,st,cfg,kids);
 // a row line with a card the user gave a height is that tall: its siblings take the line height
 if(wide){var ru=winUH(node,st,cfg,kids);if(ru!==null)return Math.max(ru,winNeed(node,w,st,cfg,kids,true))}
 var lu=0;
 for(i=0;i<vis.length;i++){
  k=winFit(node.ch[vis[i]],node.d==="r"?(wide?(node.sz[vis[i]]||0)/t*total:g.cw):w,st,cfg,kids);
  if(k===null)return null;
  r=Math.max(r,k);
  if(g){var gu=winUH(node.ch[vis[i]],st,cfg,kids);if(gu!==null)lu=Math.max(lu,gu);ln=Math.max(ln,k);if(++lc===g.k){sum+=(lu>0?lu:ln)+gap;ln=0;lc=0;lu=0}}else sum+=k;
 }
 if(g){if(lc>0)sum+=(lu>0?lu:ln)+gap;return Math.max(0,sum-gap)}
 return node.d==="r"&&wide?r:sum+(vis.length-1)*gap;
}
/** Whether a node scales with the height it is given: a chart card, a group or split holding one. A stat tile (value + sparkline), a table, a list and a group of those do not: they never take a stack's leftover height. */
function winGrow(node,st,cfg,kids){
 var i;
 if(node.k==="c"){
  var kt=kids&&kids[node.id]&&kids[node.id].k?kids[node.id]:null;
  return kt?winGrow(kt,st,cfg,kids):winLeafType(kids,node.id,cfg)==="chart";
 }
 for(i=0;i<node.ch.length;i++)if(!winGhost(st,node.ch[i].id)&&winGrow(node.ch[i],st,cfg,kids))return true;
 return false;
}
/** The default height of a node when no band gives it one: a card its type's defaultH (a table or list holding content its content height), a column the sum of its cards, a row the tallest. */
function winDef(node,st,cfg,kids){
 var i,h=0,v;
 if(node.k==="c"){
  if(winGhost(st,node.id))return 0;
  if(winMin(st,node.id))return cfg.HEAD_H;
  var d=winDefH(cfg,winLeafType(kids,node.id,cfg)),rd=cfg.content&&!winGrow(node,st,cfg,kids)?cfg.content[node.id]:null;
  var u=winUH(node,st,cfg,kids);
  if(u!==null)return u;
  return rd!==undefined&&rd!==null?Math.max(rd,winNeed(node,0,st,cfg,kids)):d;
 }
 var n=0;
 for(i=0;i<node.ch.length;i++){
  if(winGhost(st,node.ch[i].id))continue;
  v=winDef(node.ch[i],st,cfg,kids);n++;
  h=node.d==="r"?Math.max(h,v):h+v;
 }
 return node.d==="r"||n<2?h:h+(n-1)*cfg.GAP;
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
  for(i=0;i<vis.length;i++)if(ws[vis[i]]<winCardMinW(cfg,kids,node.ch[vis[i]].id))wide=false;
  var fl=winFlow(node,box.w,st,cfg,kids);
  if(fl||!wide){
   // narrow mode: stack; root gives each child its defaultH, bounded an equal share
   // a grid: as many children per line as fit at their minW, equal widths, lines stacked
   var lines=[];
   if(fl)lines=fl.lines;
   else{
    var gr=winGridK(node,box.w,st,cfg,kids);
    for(var l0=0;l0<vis.length;l0+=gr.k){var ln0=[];for(i=l0;i<Math.min(vis.length,l0+gr.k);i++)ln0.push({i:vis[i],x:(i-l0)*(gr.cw+gap),w:gr.cw});lines.push(ln0)}
   }
   var nl=lines.length;
   var h0=bounded?Math.max(0,(box.h-(nl-1)*gap)/nl):0;
   var y=0;
   for(var li=0;li<nl;li++){
    var lh=0,lo=out.length,lu2=0;
    for(var lj=0;lj<lines[li].length;lj++){
     var it=lines[li][lj],c=node.ch[it.i];
     var nf=cfg.fit&&!winMin(st,c.id)?winFit(c,it.w,st,cfg,kids):null;
     var hh=winMin(st,c.id)?cfg.HEAD_H:(nf!==null?nf:bounded?Math.max(h0,winNeed(c,it.w,st,cfg,kids)):c.k==="s"?winDef(c,st,cfg,kids):winDefH(cfg,winLeafType(kids,c.id,cfg)));
     out.push({n:c,x:it.x,y:y,w:it.w,h:hh});
     lh=Math.max(lh,hh);
     var u2=winUH(c,st,cfg,kids);if(u2!==null)lu2=Math.max(lu2,u2);
    }
    if(lu2>0)lh=lu2;
   // a line is as tall as its tallest card; a minimized card keeps its header height
    for(i=lo;i<out.length;i++)if(!winMin(st,out[i].n.id))out[i].h=lh;
    y+=lh+gap;
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
  var rest=box.h-(vis.length-1)*gap,m=0,t2=0,fxs=0,fx=[];
  for(i=0;i<vis.length;i++){
   fx.push(winMin(st,node.ch[vis[i]].id)?null:winUH(node.ch[vis[i]],st,cfg,kids));
   if(winMin(st,node.ch[vis[i]].id))m+=cfg.HEAD_H;else if(fx[i]!==null)fxs+=fx[i];else t2+=node.sz[vis[i]]||0;
  }
  // cards with a user height are fixed; the others share the rest by weight
  var avail=rest-m-fxs;if(avail<0)avail=0;
  // auto layout: every card takes its content height when they all fit the box; else the weights
  var fh=null;
  if(cfg.fit){
   var fs=[],fsum=0;
   for(i=0;i<vis.length&&fs;i++){
    var fv=winMin(st,node.ch[vis[i]].id)?0:winFit(node.ch[vis[i]],box.w,st,cfg,kids);
    if(fv===null)fs=null;else{fs.push(fv);fsum+=fv}
   }
   if(fs&&(winNar(cfg,box.w)||fsum<=avail+fxs+0.5))fh=fs;
  }
  // frozen layout: a card that does not scale with height (table, list) keeps its content height; the leftover goes to the growable cards by weight, and stays empty at the bottom when there are none
  var cg=null;
  if(!fh&&cfg.content&&t2>0){
   var cb=[],cs=0,rw=0,nr=0;
   for(i=0;i<vis.length;i++){
    var cn=node.ch[vis[i]],cv=null;
    if(!winMin(st,cn.id)&&fx[i]===null){
     // a non-growable card is held to its content reading, else to its least height: a need, never its rendered height
     var rd=null;
     if(!winGrow(cn,st,cfg,kids)){var rc=cfg.content[cn.id];rd=Math.max(rc!==undefined&&rc!==null?rc:0,winNeed(cn,box.w,st,cfg,kids))}
     // only a card whose weight share is taller than its content is capped to it
     if(rd===undefined||rd===null||(node.sz[vis[i]]||0)/t2*avail<=rd){rw+=node.sz[vis[i]]||0;nr++}
     else{cv=rd;cs+=cv}
    }
    cb.push(cv);
   }
   if(cs<=avail&&cs>0)cg={b:cb,rest:avail-cs,rw:rw,nr:nr};
  }
  var y2=0;
  for(i=0;i<vis.length;i++){
   var c2=node.ch[vis[i]],h2;
   if(winMin(st,c2.id))h2=cfg.HEAD_H;
   else if(fh)h2=fh[i];
   else if(fx[i]!==null)h2=fx[i];
   else if(cg)h2=cg.b[i]!==null?cg.b[i]:cg.rw>0?(node.sz[vis[i]]||0)/cg.rw*cg.rest:cg.rest/cg.nr;
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
  var flat=false;
  if(cfg.fit){var fb=winFit(c3,box.w,st,cfg,kids);if(fb!==null){flat=true;sz=Math.max(fb,winNeed(c3,box.w,st,cfg,kids,true))}}
  var uh=winUH(c3,st,cfg,kids);
  if(uh!==null)sz=uh;
  var h3;
  if(c3.k==="s"){
   // a band is never shorter than its cards need (a card the user made taller than the band pushes the next band down)
   if(!flat)sz=Math.max(sz,winNeed(c3,box.w,st,cfg,kids,true));
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
   h3=winMin(st,c3.id)?cfg.HEAD_H:uh!==null?uh:Math.max(winPx(st,c3.id)!==null?winPx(st,c3.id):sz,winNeed(c3,box.w,st,cfg,kids,flat&&winPx(st,c3.id)===null));
   out.push({n:c3,x:0,y:y3,w:box.w,h:h3});
  }
  y3+=h3+gap;
 }
 return out;
}
/** A card's rect and, for a group, its kids' rects (relative to its body) and docked chips. nohd: a lone child group, drawn without its header. */
function winCard(rects,id,x,y,w,ih,kids,state,cfg,nohd){
 var min=winMin(state,id),hh=nohd?0:cfg.HEAD_H;
 var h=min?cfg.HEAD_H:ih;
 rects[id]={x:x,y:y,w:w,h:h,body:{w:w,h:Math.max(0,h-hh)}};
 if(nohd)rects[id].nohd=1;
 var kt=kids&&kids[id]&&kids[id].k?kids[id]:null;
 if(kt&&!min){
  // bounded: the group body has a fixed box, so its columns lay out by weight
  var dk=winDock(cfg,id,w),bh=Math.max(0,h-hh),dh=dk.h?dk.h+cfg.GAP:0;
  var so=winSolo(kt,state,kids);
  if(so)winCard(rects,so,0,0,w,Math.max(0,bh-dh),kids,state,cfg,true);
  else{var r=layout(kt,kids,{w:w,h:Math.max(0,bh-dh)},state,cfg);for(var g in r.rects)rects[g]=r.rects[g]}
  // minimized cards of this group: title chips docked at the bottom of its body
  for(var q=0;q<dk.r.length;q++){var cr=dk.r[q];rects[cr.id]={x:cr.x,y:Math.max(0,bh-dk.h)+cr.y,w:cr.w,h:cr.h,chip:1,body:{w:cr.w,h:0}}}
 }
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
   winCard(rects,n.id,it.x,it.y,it.w,it.h,kids,state,cfg,false);
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
