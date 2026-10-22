/** cockpit-page/win — pure layout: tree -> pixel rects (spec 3.2). Pure ES5 inside a string. */

import type { WinNode } from "./tree.js";

/** The layout entry point the page script mirrors (types here are for the TS side only). */
export type WinBox = { w: number };
export type WinState = { min?: number; h?: number; sp?: number; seen?: number };
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

/** layout(tree, kids, box, state, cfg) -> {rects, height}. Pure, no DOM. Heights are content-driven: layout decides only
 *  the order, which line a card is on and its width; a card is as tall as its content (cfg.fit[id], the runtime's reading,
 *  else its type's defaultH) or the height the user set with its handle (state[id].h). No band px, no row stretch, no leftover.
 *  - box {w}: the container width (the height of the box is ignored). The result height is the bottom of the last rect.
 *  - lines: a column puts each child on its own line; a row is laid by winFlow (width shares), else in one line by weight,
 *    else (a child under its least width) in a grid. GAP px between siblings (the gutter handle is drawn in the gap).
 *    A line is as tall as its tallest card; its other cards keep their own height (aligned to the top).
 *  - minimized leaf: HEAD_H tall. cfg.dock = {group id: [minimized ids]}: chips ({chip:1}, cfg.CHIP_H tall) in rows right
 *    after the group's last line.
 *  - ghosts (state[id].seen set) take no space: skipped, no rect.
 *  - group recursion: a leaf whose id is in kids lays its kid tree in its body; kid rects are relative to the group body. */
export const WIN_LAYOUT_JS = String.raw`function winType(cfg,type){return(cfg.types&&cfg.types[type])||{}}
function winMinW(cfg,type){var t=winType(cfg,type);return t.minW!==undefined?t.minW:cfg.minW}
function winDefH(cfg,type){var t=winType(cfg,type);return t.defaultH!==undefined?t.defaultH:(cfg.defaultH||0)}
function winMin(st,id){var s=st&&st[id];return!!s&&s.min===1}
function winGhost(st,id){var s=st&&st[id];return!!s&&s.seen!==undefined}
/** The user's height of a card (st[id].h, set by its height handle): at least the header plus 40, null for none, a minimized or ghost card, a group. */
function winUH(node,st,cfg,kids){
 if(node.k!=="c")return null;
 var s=st&&st[node.id];
 if(!s||s.h===undefined||s.min===1||s.seen!==undefined||(kids&&kids[node.id]&&kids[node.id].k))return null;
 return Math.max(s.h,cfg.HEAD_H+40);
}
/** A leaf's card type: cfg.leafTypes (id -> type, set by the card runtime), else a group for a leaf with kids. */
function winLeafType(kids,id,cfg){var t=cfg&&cfg.leafTypes&&cfg.leafTypes[id];if(t)return t;var k=kids&&kids[id];return k&&k.type?k.type:(k?"group":"leaf")}
/** A card's least width in a grid: its type's minW, or its title's text width plus header controls (cfg.titleW, measured by the runtime) when that is wider, capped at 1.6 x minW (a longer title keeps its ellipsis). */
function winCardMinW(cfg,kids,id){var m=winMinW(cfg,winLeafType(kids,id,cfg)),t=cfg.titleW&&cfg.titleW[id];return t&&t>m?Math.min(t,Math.round(m*1.6)):m}
/** A card's width share inside its row: st[id].sp is the divisor (4 = 1/4, 3 = 1/3, 2 = 1/2, 1 = the whole row), absent = auto (its weight). */
function winSp(st,id){var s=st&&st[id];return s&&s.sp>0?s.sp:0}
/** The width share (st.sp divisor) a card gets when the user drags its handle to targetW: the container holds N column units
 *  (N from its least tile width), the card spans k of them (1..N); k = N is the whole row (1), else the divisor N/k. */
function winColSpan(contW,gap,minW,targetW){
 var n=Math.max(1,Math.floor((contW+gap)/(minW+gap))),cw=(contW-(n-1)*gap)/n,k=Math.round((targetW+gap)/(cw+gap));
 k=Math.max(1,Math.min(n,k));
 return k>=n?1:n/k;
}
/** Row flow: when a visible child of the row has a width share, the children are laid in lines of the row width: a share
 *  card takes that fraction (1 = its own line), an auto card its weight share of what its line has left. A card whose width
 *  falls under its least width goes on its own line. Returns null without any share, else {lines:[[{i,x,w}]]} (i = index in node.ch). */
function winFlow(node,w,st,cfg,kids){
 var i,vis=[],any=false,t=0,gap=cfg.GAP,lines=[],cur=[],fr=0,ln,j;
 for(i=0;i<node.ch.length;i++)if(!winVoid(node.ch[i],st)){vis.push(i);t+=node.sz[i]||0;if(winSp(st,node.ch[i].id))any=true}
 if(!any)return null;
 if(t<=0)t=1;
 var f=[];
 for(j=0;j<vis.length;j++){
  var id=node.ch[vis[j]].id,sp=winSp(st,id),x=sp?1/sp:(node.sz[vis[j]]||0)/t;
  if(sp&&x<1&&x*(w+gap)-gap<winCardMinW(cfg,kids,id))x=1;
  f.push(x);
 }
 // a line holds cards while the sum of their least widths and the gaps fits; a share card's fraction counts against 1 (shares yield below)
 var mn=function(q){return winCardMinW(cfg,kids,node.ch[vis[q]].id)};
 var fits=function(c){var s=(c.length-1)*gap,k;for(k=0;k<c.length;k++)s+=mn(c[k]);return s<=w+0.0001};
 for(j=0;j<vis.length;j++){
  var sj=winSp(st,node.ch[vis[j]].id)>0&&f[j]<1;
  if(cur.length&&((sj&&fr+f[j]>1.0001)||!fits(cur.concat([j])))){lines.push(cur);cur=[];fr=0}
  cur.push(j);if(sj)fr+=f[j];
  if(f[j]>=1){lines.push(cur);cur=[];fr=0}
 }
 if(cur.length)lines.push(cur);
 var out=[];
 for(i=0;i<lines.length;i++){
  ln=lines[i];var fs=0,aw=0,m=ln.length,res=[],x0=0,d=[],p=[],mt=0,ok=true;
  for(j=0;j<m;j++){var q=ln[j];mt+=mn(q);if(f[q]>=1)continue;if(winSp(st,node.ch[vis[q]].id))fs+=f[q];else aw+=node.sz[vis[q]]||0}
  var rest=w-(m-1)*gap;
  for(j=0;j<m;j++){var q2=ln[j];if(f[q2]<1&&winSp(st,node.ch[vis[q2]].id))rest-=f[q2]*(w+gap)-gap}
  for(j=0;j<m;j++){
   var p0=ln[j],pid=node.ch[vis[p0]].id;
   if(f[p0]>=1){d.push(w);p.push(1)}
   else if(winSp(st,pid)){d.push(f[p0]*(w+gap)-gap);p.push(f[p0])}
   else{var az=aw>0?(node.sz[vis[p0]]||0)/aw:1/m;d.push(rest*az);p.push(Math.max(1-fs,0.05)*az)}
   if(d[j]<mn(p0)-0.0001)ok=false;
  }
  // the preferred widths do not all hold their least width: the shares yield, every card gets its least plus a part of the slack
  if(!ok&&m>1){
   var sl=w-(m-1)*gap-mt,ps=0;
   for(j=0;j<m;j++)ps+=p[j];
   for(j=0;j<m;j++)d[j]=mn(ln[j])+Math.max(0,sl)*p[j]/ps;
  }
  for(j=0;j<m;j++){res.push({i:vis[ln[j]],x:x0,w:d[j]});x0+=d[j]+gap}
  out.push(res);
 }
 return{lines:out};
}
/** Narrow row: children per line and their equal width. At most as many as fit at the largest least width; the lines are balanced:
 *  lines = ceil(n / kMax), per line = ceil(n / lines), so earlier lines are never shorter than later ones. */
function winGridK(node,w,st,cfg,kids){
 var i,n=0,m=0,gap=cfg.GAP,k,kmax;
 for(i=0;i<node.ch.length;i++)if(!winVoid(node.ch[i],st)){n++;m=Math.max(m,winCardMinW(cfg,kids,node.ch[i].id))}
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
/** A node with nothing drawn: a ghost, or a split of such. It takes no space (no line, no gap). */
function winVoid(n,st){if(n.k==="c")return winGhost(st,n.id);for(var i=0;i<n.ch.length;i++)if(!winVoid(n.ch[i],st))return false;return true}
/** The lines of a split at width w: [[{i,x,w}]] (i = index in node.ch, ghosts left out). A column is one card per line; a row is
 *  laid by winFlow (width shares), else in one line by weight when every card keeps its least width, else in the narrow grid. */
function winLines(node,w,st,cfg,kids){
 var i,vis=[],lines=[],gap=cfg.GAP;
 for(i=0;i<node.ch.length;i++)if(!winVoid(node.ch[i],st))vis.push(i);
 if(node.d!=="r"){for(i=0;i<vis.length;i++)lines.push([{i:vis[i],x:0,w:w}]);return lines}
 var fl=winFlow(node,w,st,cfg,kids);
 if(fl)return fl.lines;
 var t=0,total=w-(vis.length-1)*gap,wide=true,x=0,ln=[];
 for(i=0;i<vis.length;i++)t+=node.sz[vis[i]]||0;
 if(t<=0)t=1;
 for(i=0;i<vis.length;i++)if((node.sz[vis[i]]||0)/t*total<winCardMinW(cfg,kids,node.ch[vis[i]].id))wide=false;
 if(wide){
  for(i=0;i<vis.length;i++){var cw=(node.sz[vis[i]]||0)/t*total;ln.push({i:vis[i],x:x,w:cw});x+=cw+gap}
  return vis.length?[ln]:[];
 }
 var gr=winGridK(node,w,st,cfg,kids);
 for(var l0=0;l0<vis.length;l0+=gr.k){ln=[];for(i=l0;i<Math.min(vis.length,l0+gr.k);i++)ln.push({i:vis[i],x:(i-l0)*(gr.cw+gap),w:gr.cw});lines.push(ln)}
 return lines;
}
/** A node's height at width w, from its content alone: a card the user's height, else its reading (cfg.fit[id], px with the header), else its type's defaultH;
 *  a group HEAD_H plus its kids plus its dock; a split the sum of its lines, a line as tall as its tallest card (cards on a line keep their own heights). */
function winH(node,w,st,cfg,kids){
 var i,j;
 if(node.k==="c"){
  if(winGhost(st,node.id))return 0;
  if(winMin(st,node.id))return cfg.HEAD_H;
  var kt=kids&&kids[node.id]&&kids[node.id].k?kids[node.id]:null;
  if(kt)return cfg.HEAD_H+winH(kt,w,st,cfg,kids)-(winSolo(kt,st,kids)?cfg.HEAD_H:0)+winDockH(cfg,node.id,w);
  var u=winUH(node,st,cfg,kids);
  if(u!==null)return u;
  var f=cfg.fit&&cfg.fit[node.id];
  return Math.max(cfg.HEAD_H,f!==undefined&&f!==null?f:winDefH(cfg,winLeafType(kids,node.id,cfg)));
 }
 var lines=winLines(node,w,st,cfg,kids),sum=0;
 for(i=0;i<lines.length;i++){var lm=0;for(j=0;j<lines[i].length;j++)lm=Math.max(lm,winH(node.ch[lines[i][j].i],lines[i][j].w,st,cfg,kids));sum+=lm}
 return sum+Math.max(0,lines.length-1)*cfg.GAP;
}
/** Lay out one split into pieces {n,x,y,w,h}: the lines top to bottom, each card at its own content height. */
function winSplit(node,box,st,cfg,kids){
 var lines=winLines(node,box.w,st,cfg,kids),out=[],y=0,i,j;
 for(i=0;i<lines.length;i++){
  var lh=0;
  for(j=0;j<lines[i].length;j++){
   var it=lines[i][j],c=node.ch[it.i],h=winH(c,it.w,st,cfg,kids);
   out.push({n:c,x:it.x,y:y,w:it.w,h:h});
   lh=Math.max(lh,h);
  }
  y+=lh+cfg.GAP;
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
  var dk=winDock(cfg,id,w),bh=Math.max(0,h-hh),kh=Math.max(0,bh-(dk.h?dk.h+cfg.GAP:0));
  var so=winSolo(kt,state,kids);
  if(so)winCard(rects,so,0,0,w,kh,kids,state,cfg,true);
  else{var r=layout(kt,kids,{w:w},state,cfg);for(var g in r.rects)rects[g]=r.rects[g]}
  // minimized cards of this group: title chips in a flow row right after the last line
  for(var q=0;q<dk.r.length;q++){var cr=dk.r[q];rects[cr.id]={x:cr.x,y:kh+(kh?cfg.GAP:0)+cr.y,w:cr.w,h:cr.h,chip:1,body:{w:cr.w,h:0}}}
 }
}
function layout(tree,kids,box,state,cfg){
 var rects={},height=0;
 if(!tree||box.w<=0)return{rects:rects,height:0};
 var out=[{n:tree,x:0,y:0,w:box.w,h:tree.k==="c"?winH(tree,box.w,state,cfg,kids):0}];
 var guard=0;
 while(out.length){
  var it=out.pop(),n=it.n;
  if(n.k==="c"){
   if(winGhost(state,n.id))continue;
   winCard(rects,n.id,it.x,it.y,it.w,it.h,kids,state,cfg,false);
   continue;
  }
  if(guard++>10000)continue;
  var ch=winSplit(n,{w:it.w},state,cfg,kids);
  for(var i=0;i<ch.length;i++){var c=ch[i];out.push({n:c.n,x:it.x+c.x,y:it.y+c.y,w:c.w,h:c.h})}
 }
 for(var id in rects)if(rects[id].y+rects[id].h>height)height=rects[id].y+rects[id].h;
 return{rects:rects,height:height};
}
`;
