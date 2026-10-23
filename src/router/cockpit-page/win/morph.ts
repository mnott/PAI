/** cockpit-page/win — keyed DOM patch behind ctx.html / ctx.list. Pure ES5 inside a string. */

/** The page-side shapes the ES5 code mirrors (types here are for the TS side only). */
export type WinMorph = (slot: Element, html: string) => void;
export type WinHtml = (slot: Element & { __html?: string }, html: string) => boolean;
export type WinList = <T>(slot: Element, items: T[], keyFn: (it: T) => string, makeRow: (it: T) => HTMLElement, updateRow?: (row: HTMLElement, it: T) => void) => void;

/** morph(slot, html): children match by data-k, else by order and tag; unchanged nodes are not touched;
 *  the focused element (links excepted: a clicked disclosure link must not pin the panel it closes) and anything with __keep is never replaced or removed. */
export const WIN_MORPH_JS = String.raw`function _mkey(n){return n.nodeType===1?n.getAttribute("data-k"):null}
function _mact(){var a=document.activeElement;return a&&a.nodeName!=="A"?a:null}
function _mkeep(n){return n.nodeType===1&&(n.__keep||(_mact()&&(n===_mact()||n.contains(_mact()))))}
function _msame(a,b){return a.nodeType===b.nodeType&&a.nodeName===b.nodeName}
function _mattrs(a,b){
 var i,n;
 for(i=a.attributes.length-1;i>=0;i--){n=a.attributes[i].name;if(!b.hasAttribute(n))a.removeAttribute(n)}
 for(i=0;i<b.attributes.length;i++){n=b.attributes[i].name;if(a.getAttribute(n)!==b.attributes[i].value)a.setAttribute(n,b.attributes[i].value)}
}
function _mnode(a,b){
 if(a.nodeType!==1){if(a.nodeValue!==b.nodeValue)a.nodeValue=b.nodeValue;return}
 if(a.isEqualNode(b))return;
 _mattrs(a,b);
 _mkids(a,b);
}
function _mkids(a,b){
 var old=Array.prototype.slice.call(a.childNodes),keyed={},free=[],i,k,o,n,want=[],used=[],fi=0;
 for(i=0;i<old.length;i++){k=_mkey(old[i]);if(k!==null&&!(k in keyed))keyed[k]=old[i];else if(k===null)free.push(old[i])}
 var nk=Array.prototype.slice.call(b.childNodes);
 for(i=0;i<nk.length;i++){
  n=nk[i];k=_mkey(n);o=null;
  if(k!==null){if(k in keyed&&_msame(keyed[k],n)){o=keyed[k];delete keyed[k]}}
  else if(fi<free.length&&_msame(free[fi],n)){o=free[fi];fi++}
  if(o){_mnode(o,n);want.push(o);used.push(o)}
  else want.push(document.importNode(n,true));
 }
 for(i=0;i<old.length;i++){if(used.indexOf(old[i])<0&&!_mkeep(old[i])){a.removeChild(old[i])}else if(used.indexOf(old[i])<0)want.push(old[i])}
 var cur=a.firstChild;
 for(i=0;i<want.length;i++){
  if(want[i]===cur)cur=cur.nextSibling;
  else a.insertBefore(want[i],cur);
 }
}
function morph(slot,html){
 var t=document.createElement("template");
 t.innerHTML=html;
 _mkids(slot,t.content);
}
/** ctx.html core: skipped when the string equals the last one written to this slot. */
function winHtml(slot,html){
 if(slot.__html===html)return false;
 morph(slot,html);slot.__html=html;return true;
}
/** ctx.list core: rows carry data-k; reused, reordered, added, removed individually. */
function winList(slot,items,keyFn,makeRow,updateRow){
 var have={},i,k,row,cur,seen={},kids=slot.children;
 for(i=0;i<kids.length;i++){k=kids[i].getAttribute("data-k");if(k!==null)have[k]=kids[i]}
 cur=slot.firstElementChild;
 for(i=0;i<items.length;i++){
  k=String(keyFn(items[i]));seen[k]=1;row=have[k];
  if(!row){row=makeRow(items[i]);row.setAttribute("data-k",k)}
  if(updateRow)updateRow(row,items[i]);
  if(row===cur)cur=cur.nextElementSibling;
  else slot.insertBefore(row,cur);
 }
 for(k in have){if(!seen[k]&&slot===have[k].parentNode)slot.removeChild(have[k])}
}
`;
