/** cockpit-page/win — persistence (spec 6). Pure ES5 inside a string; storage is injected
 *  (localStorage in the page, an in-memory object in tests). No DOM, no timers. */

/** State per card id: min 1 minimized / 0 explicitly restored (a default-minimized card the
 *  user restored stores 0 and wins over the default); seen last-seen ms, drives ghost pruning. */
export type WinCardState = { min?: 0 | 1; seen?: number };
export type WinStore = {
  v: number;
  tree: unknown;
  kids: Record<string, unknown>;
  st: Record<string, WinCardState>;
};

/** The layout object the page persists under WIN_KEY. */
export const WIN_KEY = "pai.cockpit.win.v2";
/** Bump only when the tree schema changes (spec 6). */
export const LAYOUT_V = 2;
/** A gone card keeps its place in the tree this long (spec 3.4). */
export const GHOST_DAYS = 30;
/** Pre-v2 keys: their models do not map onto the tree; deleted on first load (spec 6). */
export const OLD_KEYS = ["pai.cockpit.layout.v1", "pai.cockpit.tiles.v1", "pai.cockpit.collapsed"];

/** defaults: { tree, kids, stDefaults } — the shipped default layout (win-defaults.ts later);
 *  stDefaults holds the default min flags (e.g. the zero-metric cards).
 *  knownIds: every id the registry and the dynamic sources currently know.
 *  loadWin returns { tree, kids, st } — never null; invalid or old data falls back to defaults.
 *  A device with no layout of its own starts from defaults.served (the install's saved default) when there is one. */
export const WIN_STORE_JS = String.raw`var WIN_KEY="pai.cockpit.win.v2";
var LAYOUT_V=2;
var GHOST_MS=30*24*60*60*1000;
var SEEN_KEY="pai.cockpit.win.defaultSeen";
var OLD_KEYS=["pai.cockpit.layout.v1","pai.cockpit.tiles.v1","pai.cockpit.collapsed"];
function clone(o){return o===undefined||o===null?o:JSON.parse(JSON.stringify(o))}
function defaultsOf(defaults){var d=flatDefaults(defaults);migrateState(d.stDefaults);return{tree:d.tree,kids:d.kids||{},st:d.stDefaults}}
/** Parse the stored object. Invalid JSON, a missing/lower v, or a non-object -> null (defaults). */
function parseWin(raw){
 if(!raw)return null;
 var obj;try{obj=JSON.parse(raw)}catch(e){return null}
 if(!obj||typeof obj!=="object"||obj.k==="c"||obj.k==="s")return null;
 if(typeof obj.v!=="number"||obj.v<LAYOUT_V)return null;
 if(!obj.tree||typeof obj.tree!=="object")return null;
 return obj;
}
/** Normalise every st[id].min to 1 when truthy, else to 0: older saves and cross-tab adoption
 *  can carry true, "1" or 2, and the one rule (isMin, winMin, winGMin) is min===1. A stored 0
 *  is an explicit restore and stays; a state object with no min gets none. */
function normMin(st){
 for(var id in st){
  var s=st[id];
  if(!s||typeof s!=="object"||s.min===undefined)continue;
  st[id].min=s.min?1:0;
 }
}
/** The stored per-card state is exactly {min, h, w, seen}: min 1/0 minimized, h the user's height of the card body, w its width in
 *  12ths of its group (3 4 6 8 9 12), seen the last-seen ms. Every other field of older saves (px, ub, sp, fits, positions) goes;
 *  an old width divisor sp becomes w. */
var WIN_UNITS=[3,4,6,8,9,12];
function unitsOf(f){
 var x=f*12,best=12,bd=1e9,i,d;
 for(i=0;i<WIN_UNITS.length;i++){d=Math.abs(WIN_UNITS[i]-x);if(d<bd){bd=d;best=WIN_UNITS[i]}}
 return best;
}
function migrateState(st){
 for(var id in st){
  var s=st[id];
  if(!s||typeof s!=="object"){delete st[id];continue}
  if(s.w===undefined&&s.sp>0)s.w=unitsOf(1/s.sp);
  if(WIN_UNITS.indexOf(s.w)<0)delete s.w;
  if(!(s.h>0))delete s.h;
  for(var k in s)if(k!=="min"&&k!=="h"&&k!=="w"&&k!=="seen")delete s[k];
 }
}
/** A container's tree is a flat column of cards (parent + order): a row split of an older save becomes consecutive cards,
 *  each with the width it had, as units in st.w. Returns the flat column (a lone card stays a leaf), null for none. */
function flatTree(node,st){
 if(!node)return null;
 var out=[];
 (function walk(n,f){
  if(n.k==="c"){
   if(f<0.999){var s=st[n.id]=st[n.id]||{};if(s.w===undefined)s.w=unitsOf(f)}
   out.push(leaf(n.id));return;
  }
  var t=0,i;for(i=0;i<n.sz.length;i++)t+=n.sz[i];
  for(i=0;i<n.ch.length;i++)walk(n.ch[i],n.d==="r"&&t>0?f*n.sz[i]/t:f);
 })(node,1);
 if(!out.length)return null;
 if(out.length===1)return out[0];
 return split("c",out,out.map(function(){return 1/out.length}));
}
/** The defaults with every container flattened; the widths of their rows land in stDefaults. */
function flatDefaults(d){
 var o=clone(d),st=o.stDefaults=o.stDefaults||{},g;
 o.tree=flatTree(o.tree,st);
 for(g in o.kids||{})o.kids[g]=flatTree(o.kids[g],st);
 return o;
}
/** Delete the pre-v2 keys (their models do not map onto the tree). */
function deleteOldKeys(storage){
 for(var i=0;i<OLD_KEYS.length;i++){try{storage.removeItem(OLD_KEYS[i])}catch(e){}}
}
/** Prune ghosts: ids in the tree not in knownIds whose seen is older than GHOST_MS.
 *  An id with no seen stamp is treated as just seen (a save from an older page version).
 *  Ghosts in the root and in every group body; a group whose body empties loses its entry. */
function pruneGhosts(tree,kids,st,knownIds,now){
 var known={},i;
 for(i=0;i<knownIds.length;i++)known[knownIds[i]]=1;
 var gone=[];
 function walk(n){
  if(!n)return;
  if(n.k==="c"){
   if(!known[n.id]){
    var s=st[n.id]||{};
    var seen=typeof s.seen==="number"?s.seen:now;
    if(now-seen>GHOST_MS)gone.push(n.id);
   }
   return;
  }
  for(var j=0;j<n.ch.length;j++)walk(n.ch[j]);
 }
 walk(tree);
 for(var g in kids)walk(kids[g]);
 for(i=0;i<gone.length;i++){
  var id=gone[i];
  tree=removeLeaf(tree,id,true);
  for(var g2 in kids){
   kids[g2]=removeLeaf(kids[g2],id,false);
   if(!kids[g2])delete kids[g2];
  }
  delete st[id];
 }
 return tree;
}
/** Insert missing static ids next to their default neighbour (else as a new band at the end).
 *  prevOf maps an id to the id the default layout places right before it; the anchor is the first default
 *  neighbour that lives in this container and is known (an unknown id is not an anchor).
 *  Root tree and group bodies alike; missing holds only ids this container owns, so a
 *  group's ids never land in the root. Returns the new tree. */
function insertMissing(node,missing,prevOf,knownIds,isRoot,defaultsNode){
 if(!missing.length)return node;
 var known={},i;
 for(i=0;i<knownIds.length;i++)known[knownIds[i]]=1;
 // anchors are cards the saved tree already had, never ones this pass just inserted
 var present={},defIds={},pi,sv=ids(node),dv=ids(defaultsNode);
 for(pi=0;pi<sv.length;pi++)present[sv[pi]]=1;
 for(pi=0;pi<dv.length;pi++)defIds[dv[pi]]=1;
 function anchorOf(n,id){
  var prv=prevOf[id];
  while(prv&&!(known[prv]&&present[prv]))prv=prevOf[prv];
  return prv;
 }
 /** The chain of nodes from n down to the leaf id (n itself first), or null. */
 function pathTo(n,id){
  if(!n)return null;
  if(n.k==="c")return n.id===id?[n]:null;
  for(var j=0;j<n.ch.length;j++){
   var sub=pathTo(n.ch[j],id);
   if(sub)return[n].concat(sub);
  }
  return null;
 }
 /** Insert id right after anchor, mirroring the default layout: if the default holds both
 *  in a row, the card joins that row (a band that collapsed to a single leaf regains its
 *  row); otherwise it goes after the anchor in the anchor's parent, else as a new band. */
function placeLeaf(n,id){
  var nxt=anchorOf(n,id);
  if(nxt){
   var p=parentOf(n,nxt);
   if(p){
    var idx=-1;
    for(var m=0;m<p.ch.length;m++)if(p.ch[m].k==="c"&&p.ch[m].id===nxt){idx=m;break}
    if(idx>=0){p.ch.splice(idx+1,0,leaf(id));p.sz.splice(idx+1,0,0.5);return n}
   }
  }
  if(!isSplit(n))n=split("c",[n],[isRoot?400:1]);
  n.ch.push(leaf(id));n.sz.push(isRoot?400:0.5);
  return n;
 }
 for(i=0;i<missing.length;i++)node=placeLeaf(node,missing[i]);
 return normalize(node,isRoot!==false);
}
/** The ids this container's own default subtree has but its saved tree lacks, in default
 *  order, limited to ids the registry knows now (a default card the page does not carry is
 *  not inserted). */
function missingIn(defNode,node,knownIds){
 var have={},acc=ids(node),i;
 for(i=0;i<acc.length;i++)have[acc[i]]=1;
 var out=[];
 function walk(n){
  if(!n)return;
  if(n.k==="c"){if(!have[n.id]&&out.indexOf(n.id)<0)out.push(n.id);return}
  for(var k=0;k<n.ch.length;k++)walk(n.ch[k]);
 }
 walk(defNode);
 var known={},m;
 for(m=0;m<knownIds.length;m++)known[knownIds[m]]=1;
 var out2=[];
 for(m=0;m<out.length;m++)if(known[out[m]])out2.push(out[m]);
 return out2;
}
/** id -> the card the default layout places right before it in the same parent (root and
 *  group bodies), or null for a first child. */
function prevOfDefault(defaults){
 var prev={};
 function walk(n){
  if(!n||n.k==="c")return;
  for(var i=0;i<n.ch.length;i++){
   var c=n.ch[i];
   if(c.k==="c")prev[c.id]=(i>0&&n.ch[i-1].k==="c")?n.ch[i-1].id:null;
   walk(c);
  }
 }
 walk(defaults.tree);
 for(var g in defaults.kids||{})walk(defaults.kids[g]);
 return prev;
}
/** Load the layout: parse, prune ghosts, insert missing static cards, merge default min
 *  flags under the saved state. Invalid or old data -> defaults. Old keys are deleted. */
/** The layout the router serves as this install's default (a fresh copy), or null: absent, or not a layout of this schema. */
function servedOf(defaults){
 var s=defaults&&defaults.served;
 if(!s||typeof s!=="object"||typeof s.v!=="number"||s.v<LAYOUT_V||!s.tree||typeof s.tree!=="object")return null;
 return clone(s);
}
/** The savedAt (server ms) of the served default, 0 when it has none (the shipped one). */
function servedAt(defaults){return defaults&&typeof defaults.savedAt==="number"?defaults.savedAt:0}
/** The savedAt of the default this device last adopted. */
function seenAt(storage){var n=0;try{n=Number(storage.getItem(SEEN_KEY))}catch(e){}return n>0?n:0}
/** A saved default newer than the one this device adopted exists (served with the page or reported by a poll as at). */
function defaultPending(storage,at){return typeof at==="number"&&at>seenAt(storage)}
/** Take the newer default: forget the local layout and the seen stamp; the next loadWin adopts the served one. */
function adoptDefault(storage){try{storage.removeItem(WIN_KEY);storage.removeItem(SEEN_KEY)}catch(e){}}
function loadWin(storage,defaults,knownIds,now){
 now=typeof now==="number"?now:Date.now();
 deleteOldKeys(storage);
 var raw=null;
 try{raw=storage.getItem(WIN_KEY)}catch(e){}
 var own=parseWin(raw),sv=servedOf(defaults),at=servedAt(defaults);
 // a newer saved default replaces a layout this device has not edited since it was saved; a device edited after it keeps its own (the page offers the default)
 if(own&&sv&&defaultPending(storage,at)&&!(typeof own.t==="number"&&own.t>=at)){
  own=null;try{storage.removeItem(WIN_KEY)}catch(e){}
 }
 if(!own&&sv&&at>0){try{storage.setItem(SEEN_KEY,String(at))}catch(e){}}
 var obj=own||sv;
 if(!obj)return defaultsOf(defaults);
 var r=reconcileSaved(obj,defaults,knownIds,now);
 if(obj.auto===1)r.tree=repairOrder(r.tree,defaults.tree);
 return r;
}
/** A layout saved by a page that composed before the default tree was complete can hold the root bands in a
 *  scrambled order. Only an auto layout (no user move) whose root differs from the default solely by that order
 *  is put back; anything else is the user's and stays. */
function repairOrder(tree,def){
 if(!tree||!def||tree.k!=="s"||def.k!=="s"||tree.d!=="c"||def.d!=="c"||tree.ch.length!==def.ch.length)return tree;
 var at={},i;
 for(i=0;i<tree.ch.length;i++){if(tree.ch[i].k!=="c")return tree;at[tree.ch[i].id]=i}
 var ch=[],sz=[];
 for(i=0;i<def.ch.length;i++){
  if(def.ch[i].k!=="c"||at[def.ch[i].id]===undefined)return tree;
  ch.push(tree.ch[at[def.ch[i].id]]);sz.push(tree.sz[at[def.ch[i].id]]);
 }
 var fixed={k:"s",d:"c",ch:ch,sz:sz};
 return JSON.stringify(fixed)===JSON.stringify(def)?fixed:tree;
}
/** Cards that live in a default top-level group, {cardId: groupId}. A layout saved before a group existed holds
 *  its cards as root bands. */
var OLD_HOME={speed:"tokens-group"};
var GROUP_OF={tokens:"tokens-group",daily:"tokens-group",speed:"perf-group",runs:"perf-group",sessions:"perf-group",pause:"perf-group"};
/** A stored tree whose root holds mapped cards as bands, for a group that is not stored yet: the group is created at
 *  the first of them, they move in with their px heights as the body weights. A card the user put inside some group
 *  stays there; a group whose cards sit only elsewhere is dropped from the defaults so it is not inserted over them.
 *  Returns { tree, defaults }. */
function groupRoots(tree,kids,defaults){
 if(!defaults||!defaults.kids)return{tree:tree,defaults:defaults};
 var d=defaults,gs=[],c,g,i;
 for(c in GROUP_OF)if(gs.indexOf(GROUP_OF[c])<0)gs.push(GROUP_OF[c]);
 for(var n=0;n<gs.length;n++){
  g=gs[n];
  if(!defaults.kids[g]||kids[g]||findLeaf(tree,g))continue;
  var at=[];
  if(tree&&tree.k==="s"&&tree.d==="c")for(i=0;i<tree.ch.length;i++)if(tree.ch[i].k==="c"&&GROUP_OF[tree.ch[i].id]===g)at.push(i);
  if(at.length){
   var ch=[],sum=0,j;
   for(j=0;j<at.length;j++){ch.push(tree.ch[at[j]]);sum+=tree.sz[at[j]]}
   var w=at.map(function(k){return sum>0?tree.sz[k]/sum:1/at.length});
   kids[g]=split("c",ch,w);
   tree.ch[at[0]]=leaf(g);tree.sz[at[0]]=sum;
   for(j=at.length-1;j>0;j--){tree.ch.splice(at[j],1);tree.sz.splice(at[j],1)}
   continue;
  }
  var hit=false;
  for(c in GROUP_OF)if(GROUP_OF[c]===g){
   if(ids(tree).indexOf(c)>=0)hit=true;
   for(var k in kids)if(ids(kids[k]).indexOf(c)>=0)hit=true;
  }
  if(hit){
   if(d===defaults)d=clone(defaults);
   d.tree=removeLeaf(d.tree,g,true);
   delete d.kids[g];
  }
 }
 return{tree:tree,defaults:d};
}
/** Default groups that moved into another existing group, {groupId: parentGroupId}. A layout saved before holds the
 *  group as a root band. */
var NEST_INTO={"sys-servers":"models"};
/** A stored root band for a nested default group moves in as the first child of its parent's body (40% of it). Only
 *  a band at root moves; one the user put elsewhere stays. */
function nestRoots(tree,kids){
 if(!tree||tree.k!=="s"||tree.d!=="c")return;
 for(var g in NEST_INTO){
  var p=NEST_INTO[g],body=kids[p],i;
  if(!body||!kids[g])continue;
  for(i=0;i<tree.ch.length;i++)if(tree.ch[i].k==="c"&&tree.ch[i].id===g)break;
  if(i>=tree.ch.length)continue;
  tree.ch.splice(i,1);tree.sz.splice(i,1);
  if(body.k==="s"&&body.d==="c"){
   var t=0,j;
   for(j=0;j<body.sz.length;j++)t+=body.sz[j];
   body.ch.unshift(leaf(g));body.sz=[0.4].concat(body.sz.map(function(v){return t>0?v/t*0.6:0.6/body.sz.length}));
  }else kids[p]=split("c",[leaf(g),body],[0.4,0.6]);
 }
}
/** A saved layout that lists a card more than once (root band and a group body, or two bodies) keeps one occurrence: the one the
 *  user placed, i.e. outside the container the default layout holds the card in; else the first. Mutates kids; returns the tree. */
function dedupeCards(tree,kids,defaults){
 var where={},order=[],seen={},g,i,a;
 function note(c,list){for(var j=0;j<list.length;j++){if(!where[list[j]]){where[list[j]]=[];order.push(list[j])}where[list[j]].push(c)}}
 note("",ids(tree));
 for(g in kids)note(g,ids(kids[g]));
 var defAt={};
 function defNote(c,t){var l=ids(t);for(var j=0;j<l.length;j++)if(defAt[l[j]]===undefined)defAt[l[j]]=c}
 if(defaults){defNote("",defaults.tree);for(g in defaults.kids||{})defNote(g,defaults.kids[g])}
 for(i=0;i<order.length;i++){
  var id=order[i];a=where[id];
  if(a.length<2)continue;
  // a copy inside a group always wins over one at the page root; then the one outside the default container (the user's placement)
  var keep=a[0],k,pool=a.filter(function(x){return x!==""});
  if(!pool.length)pool=a;
  keep=pool[0];
  for(k=0;k<pool.length;k++)if(pool[k]!==defAt[id]){keep=pool[k];break}
  var done=false;
  for(k=0;k<a.length;k++){
   var c=a[k];
   if(c===keep&&!done){done=true;continue}
   if(c==="")tree=removeLeaf(tree,id,true)||tree;
   else{var r=removeLeaf(kids[c],id,false);if(r)kids[c]=r;else delete kids[c]}
  }
 }
 return tree;
}
/** True when card id sits in the tree or in any group body. */
function placedAnywhere(tree,kids,id){
 if(ids(tree).indexOf(id)>=0)return true;
 for(var k in kids)if(ids(kids[k]).indexOf(id)>=0)return true;
 return false;
}
/** Reconcile a parsed saved layout with the defaults: prune ghosts, insert missing static
 *  cards (a card the user moved to another container is not inserted again into its default one), merge default min flags under the saved state. Returns { tree, kids, st }. */
function reconcileSaved(saved,defaults,knownIds,now){
 now=typeof now==="number"?now:Date.now();
 knownIds=knownIds||[];
 defaults=flatDefaults(defaults);
 var st=saved.st&&typeof saved.st==="object"?saved.st:{};
 migrateState(st);migrateState(defaults.stDefaults);
 var tree=flatTree(saved.tree,st),kids=saved.kids&&typeof saved.kids==="object"?saved.kids:{};
 for(var kg in kids){var kt=flatTree(kids[kg],st);if(kt)kids[kg]=kt;else delete kids[kg]}
 var mig=groupRoots(tree,kids,defaults);
 tree=mig.tree;defaults=mig.defaults;
 nestRoots(tree,kids);
 // speed lived in the Tokens group before it moved to Performance details: a save that still holds it there follows the move
 for(var oc in OLD_HOME)if(kids[GROUP_OF[oc]]&&kids[OLD_HOME[oc]]&&findLeaf(kids[OLD_HOME[oc]],oc)){var rem=removeLeaf(kids[OLD_HOME[oc]],oc,false);if(rem)kids[OLD_HOME[oc]]=rem;else delete kids[OLD_HOME[oc]]}
 tree=dedupeCards(tree,kids,defaults);
 // a mapped card left at the page root while its group exists goes back into the group (insertMissing below places it)
 for(var mc in GROUP_OF)if(kids[GROUP_OF[mc]]&&findLeaf(tree,mc)&&!(function(){for(var q in kids)if(findLeaf(kids[q],mc))return true;return false})())tree=removeLeaf(tree,mc,true)||tree;
 tree=pruneGhosts(tree,kids,st,knownIds,now);
 var prevOf=prevOfDefault(defaults);
 tree=insertMissing(tree,missingIn(defaults.tree,tree,knownIds),prevOf,knownIds,true,defaults.tree);
 for(var g in kids){
  var defKid=(defaults.kids||{})[g];
  if(defKid)kids[g]=insertMissing(kids[g],missingIn(defKid,kids[g],knownIds).filter(function(m){return !placedAnywhere(tree,kids,m)}),prevOf,knownIds,false,defKid);
 }
 var sd=defaults.stDefaults||{};
 for(var id in sd){if(st[id]===undefined)st[id]=clone(sd[id]);else if(st[id].w===undefined&&sd[id].w!==undefined)st[id].w=sd[id].w}
 normMin(st);
 return{tree:tree,kids:kids,st:st};
}
/** One write, whole object, debounced by the caller (spec 6). t is the save time: another tab compares it to know which layout is newer. Returns t. */
function saveWin(storage,tree,kids,st,auto){
 var o={v:LAYOUT_V,t:Date.now(),tree:tree,kids:kids||{},st:st||{}};
 // auto: the sizes are still the defaults (heights follow the content); a layout saved without it holds the user's sizes
 if(auto)o.auto=1;
 try{storage.setItem(WIN_KEY,JSON.stringify(o))}catch(e){}
 return o.t;
}
/** Reset: the defaults, fresh state (minimized state resets too, spec 6). */
function resetWin(defaults){return defaultsOf(defaults)}
`;
