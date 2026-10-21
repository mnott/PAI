/** cockpit-page/win — split-tree types and normalize (spec 3.1). Pure ES5 inside a string. */

/** The tree node shapes the page script mirrors (types here are for the TS side only). */
export type WinLeaf = { k: "c"; id: string };
export type WinSplit = { k: "s"; d: "r" | "c"; ch: WinNode[]; sz: number[] };
export type WinNode = WinLeaf | WinSplit;

/** Tree helpers, testable with new Function. Invariants after normalize (spec 3.1):
 *  a Split has at least 2 children (a one-child split is replaced by the child);
 *  a Split never has a direct Split child of the same d (merged, weights multiplied);
 *  sz.length === ch.length; all weights > 0; weights of a split sum to 1. */
export const WIN_TREE_JS = String.raw`function leaf(id){return{k:"c",id:String(id)}}
function split(d,ch,sz){return{k:"s",d:d==="c"?"c":"r",ch:ch||[],sz:sz||[]}}
function isSplit(n){return!!n&&n.k==="s"}
/** Bottom-up normalize: children first, then this node. isRoot marks the top node. */
function normalize(node,isRoot){
 if(!isSplit(node))return node;
 var ch=[],sz=[],i;
 for(i=0;i<node.ch.length;i++){
  var c=normalize(node.ch[i],false);
  if(isSplit(c)&&c.d===node.d){
   // merge same-direction nesting: the child's weights are relative to the child, so multiply
   var w=node.sz[i]||0;
   for(var j=0;j<c.ch.length;j++){ch.push(c.ch[j]);sz.push(w*(c.sz[j]||0))}
  }else{ch.push(c);sz.push(node.sz[i])}
 }
 node.ch=ch;node.sz=sz;
 // drop non-positive weights, then collapse a split that lost its siblings
 var keep=[],ks=[];
 for(i=0;i<ch.length;i++)if(!(sz[i]<=0)){keep.push(ch[i]);ks.push(sz[i])}
 node.ch=keep;node.sz=ks;
 if(node.ch.length===1)return node.ch[0];
 if(node.ch.length===0)return null;
 renorm(node,isRoot!==false);
 return node;
}
/** Rescale sz so it sums to 1. A root column (the top node, d "c") holds band px and is left
 *  alone; every other split holds weights. */
function renorm(node,isRoot){
 if(isRoot&&node.d==="c")return node;
 var t=0,i;for(i=0;i<node.sz.length;i++)t+=node.sz[i];
 if(t<=0)return node;
 for(i=0;i<node.sz.length;i++)node.sz[i]=node.sz[i]/t;
 return node;
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
 if(!isSplit(tree))return null;
 for(var i=0;i<tree.ch.length;i++){
  var c=tree.ch[i];
  if(c.k==="c"&&c.id===id)return tree;
  var r=parentOf(c,id);if(r)return r;
 }
 return null;
}
/** Leaf ids in reading order: left to right, top to bottom (rows first, columns stacked). */
function ids(tree){
 var out=[];
 if(!tree)return out;
 if(tree.k==="c"){out.push(tree.id);return out}
 for(var i=0;i<tree.ch.length;i++)out=out.concat(ids(tree.ch[i]));
 return out;
}
/** Remove the leaf (mutates in place), then normalize the result. Returns the new tree
 *  (null when the last child of the root was removed — the band is gone). */
function removeLeaf(tree,id){
 if(!tree)return null;
 if(tree.k==="c")return tree.id===id?null:tree;
 for(var i=0;i<tree.ch.length;i++){
  var c=tree.ch[i];
  if(c.k==="c"){if(c.id===id){tree.ch.splice(i,1);tree.sz.splice(i,1);break}}
  else if(findLeaf(c,id)){tree.ch[i]=removeLeaf(c,id);break}
 }
 return normalize(tree,true);
}
`;
