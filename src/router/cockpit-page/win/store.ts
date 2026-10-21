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
 *  loadWin returns { tree, kids, st } — never null; invalid or old data falls back to defaults. */
export const WIN_STORE_JS = String.raw`var WIN_KEY="pai.cockpit.win.v2";
var LAYOUT_V=2;
var GHOST_MS=30*24*60*60*1000;
var OLD_KEYS=["pai.cockpit.layout.v1","pai.cockpit.tiles.v1","pai.cockpit.collapsed"];
function clone(o){return o===undefined||o===null?o:JSON.parse(JSON.stringify(o))}
function defaultsOf(defaults){return{tree:clone(defaults.tree),kids:clone(defaults.kids||{}),st:clone(defaults.stDefaults||{})}}
/** Parse the stored object. Invalid JSON, a missing/lower v, or a non-object -> null (defaults). */
function parseWin(raw){
 if(!raw)return null;
 var obj;try{obj=JSON.parse(raw)}catch(e){return null}
 if(!obj||typeof obj!=="object"||obj.k==="c"||obj.k==="s")return null;
 if(typeof obj.v!=="number"||obj.v<LAYOUT_V)return null;
 if(!obj.tree||typeof obj.tree!=="object")return null;
 return obj;
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
function place(n,id){
  var nxt=anchorOf(n,id);
  if(nxt){
   // the default row rule: if the default layout holds the anchor and id side by side in a
   // row, the new card joins that row wherever the anchor lives in the saved tree
   var defRow=null,defIdx=-1;
   var dp=parentOf(defaultsNode,nxt);
   if(dp&&dp.d==="r"){
    for(var q=0;q<dp.ch.length;q++)if(dp.ch[q].k==="c"&&dp.ch[q].id===nxt){defIdx=q;break}
    if(defIdx>=0&&defIdx+1<dp.ch.length&&dp.ch[defIdx+1].k==="c"&&dp.ch[defIdx+1].id===id)defRow=dp;
   }
   if(defRow){
    var path=pathTo(n,nxt);
    var ri=-1,k;
    if(path){
     var row=path.length>=2?path[path.length-2]:null;
     if(row&&row.k==="s"&&row.d==="r"){
      for(k=0;k<row.ch.length;k++)if(row.ch[k].k==="c"&&row.ch[k].id===nxt){ri=k;break}
     }
    }
    if(ri>=0){
     // the anchor lives in a row in the saved tree: join that row, side by side
     var par=row;
     // skip saved cards the defaults do not know (ghosts): they keep their place after the anchor
     while(ri+1<par.ch.length&&par.ch[ri+1].k==="c"&&!defIds[par.ch[ri+1].id])ri++;
     par.ch.splice(ri+1,0,leaf(id));par.sz.splice(ri+1,0,0.5);
     return n;
    }
    // the anchor sits alone in a band (its default row collapsed): the band regains a row
    // [anchor, id] and keeps its px height
    if(path&&path.length>=2&&path[path.length-1].k==="c"&&path[path.length-2].k==="s"&&path[path.length-2].d==="c"){
     var band=path[path.length-2],ci=-1;
     for(k=0;k<band.ch.length;k++)if(band.ch[k]===path[path.length-1]){ci=k;break}
     if(ci>=0){
      band.ch[ci]=split("r",[path[path.length-1],leaf(id)],[0.5,0.5]);
      return n;
     }
    }
   }
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
 for(i=0;i<missing.length;i++)node=place(node,missing[i]);
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
function loadWin(storage,defaults,knownIds,now){
 now=typeof now==="number"?now:Date.now();
 deleteOldKeys(storage);
 var raw=null;
 try{raw=storage.getItem(WIN_KEY)}catch(e){}
 var obj=parseWin(raw);
 if(!obj)return defaultsOf(defaults);
 return reconcileSaved(obj,defaults,knownIds,now);
}
/** Reconcile a parsed saved layout with the defaults: prune ghosts, insert missing static
 *  cards, merge default min flags under the saved state. Returns { tree, kids, st }. */
function reconcileSaved(saved,defaults,knownIds,now){
 now=typeof now==="number"?now:Date.now();
 knownIds=knownIds||[];
 var tree=saved.tree,kids=saved.kids&&typeof saved.kids==="object"?saved.kids:{};
 var st=saved.st&&typeof saved.st==="object"?saved.st:{};
 tree=pruneGhosts(tree,kids,st,knownIds,now);
 var prevOf=prevOfDefault(defaults);
 tree=insertMissing(tree,missingIn(defaults.tree,tree,knownIds),prevOf,knownIds,true,defaults.tree);
 for(var g in kids){
  var defKid=(defaults.kids||{})[g];
  if(defKid)kids[g]=insertMissing(kids[g],missingIn(defKid,kids[g],knownIds),prevOf,knownIds,false,defKid);
 }
 var sd=defaults.stDefaults||{};
 for(var id in sd)if(st[id]===undefined)st[id]=clone(sd[id]);
 return{tree:tree,kids:kids,st:st};
}
/** One write, whole object, debounced by the caller (spec 6). */
function saveWin(storage,tree,kids,st,auto){
 var o={v:LAYOUT_V,tree:tree,kids:kids||{},st:st||{}};
 // auto: the sizes are still the defaults (heights follow the content); a layout saved without it holds the user's sizes
 if(auto)o.auto=1;
 try{storage.setItem(WIN_KEY,JSON.stringify(o))}catch(e){}
}
/** Reset: the defaults, fresh state (minimized state resets too, spec 6). */
function resetWin(defaults){return defaultsOf(defaults)}
`;
