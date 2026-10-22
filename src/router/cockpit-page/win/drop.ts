/** cockpit-page/win — drag/drop tree ops (spec 3.3). Pure ES5 inside a string. No DOM, no geometry but the rects the caller hands in.
 *  A container (the root, a group's kids) is an ordered list of cards; a drop only changes that order and the parent. */

export type WinZone = "left" | "right" | "top" | "bottom" | "into" | "none";

/** zoneAt(rect, p) -> "left"|"right"|"top"|"bottom"|"none": the four edge bands are the
 *  outer 25% of width/height; corners go to the nearer edge by distance; the middle is
 *  "none". moveCard(root, kids, dragId, targetId, zone) -> {tree, kids} (copies), or null for an impossible drop
 *  (onto itself, into its own group, unknown card, zone none, a target outside the card's own container): left/top put the card before the target in the container, right/bottom after it, "into" (the group the card is already in) first in its kids. A drop that changes nothing returns null too.
 *  neighbor(rects,id,dir) -> the id of the nearest visible card in that direction, or null.
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
/** A list of card ids as a container tree: none = null, one = the leaf, else a flat column. */
function listTree(list){
 if(!list.length)return null;
 if(list.length===1)return leaf(list[0]);
 return split("c",list.map(leaf),list.map(function(){return 1/list.length}));
}
/** The container of id: "" for the root, else the group id; undefined when no container holds it. */
function containerOf(root,kids,id){
 if(root&&findLeaf(root,id))return"";
 for(var g in kids)if(kids[g]&&findLeaf(kids[g],id))return g;
 return undefined;
}
/** Is group g, or a group inside it, the card id? (A group may not be dropped into itself.) */
function inside(kids,g,id){
 if(g===id)return true;
 var a=kids[g]?ids(kids[g]):[],i;
 for(i=0;i<a.length;i++)if(kids[a[i]]&&kids[a[i]].k&&inside(kids,a[i],id))return true;
 return a.indexOf(id)>=0;
}
function moveCard(root,kids,dragId,targetId,zone){
 if(dragId===targetId||zone==="none"||!zone)return null;
 var from=containerOf(root,kids,dragId),to=containerOf(root,kids,targetId);
 if(from===undefined||to===undefined)return null;
 if(from!==(zone==="into"?targetId:to))return null; // a card is reordered inside its own section only; moving between sections is not a drag action
 if(kids[dragId]&&kids[dragId].k&&inside(kids,dragId,targetId))return null;
 var lists={"":root?ids(root):[]},g;
 for(g in kids)lists[g]=kids[g]&&kids[g].k?ids(kids[g]):[];
 var before=JSON.stringify(lists);
 lists[from].splice(lists[from].indexOf(dragId),1);
 if(zone==="into"){
  if(!(kids[targetId]&&kids[targetId].k))return null;
  lists[targetId].unshift(dragId);
 }else{
  var at=lists[to].indexOf(targetId);
  lists[to].splice(zone==="right"||zone==="bottom"?at+1:at,0,dragId);
 }
 if(JSON.stringify(lists)===before)return null;
 var out={};
 for(g in kids)if(lists[g].length)out[g]=listTree(lists[g]);
 return{tree:listTree(lists[""]),kids:out};
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
  if(dir==="left"){if(O.x+O.w>R.x+1)continue;d=R.x-(O.x+O.w)}
  else if(dir==="right"){if(O.x<R.x+R.w-1)continue;d=O.x-(R.x+R.w)}
  else if(dir==="up"){if(O.y+O.h>R.y+1)continue;d=R.y-(O.y+O.h)}
  else if(dir==="down"){if(O.y<R.y+R.h-1)continue;d=O.y-(R.y+R.h)}
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
`;
