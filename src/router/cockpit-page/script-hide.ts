/** cockpit-page — script: hide rules (router.cockpit.hide). Page-scope ES5, after scriptCore (esc in scope), before scriptTables.
 *  The rules come from GET /cockpit/hide and are written whole through POST /cockpit/hide (the server validates; the matcher is the
 *  same as src/router/cockpit-hide.ts). Rows are filtered on the data the page already has: hideFilter() per list, which also records
 *  the row texts it saw (HIDE_SEEN: the count each rule hides now) and the number hidden (HIDE_N: the "N hidden" in the card header).
 *  "Show hidden" is per viewer (localStorage). One inline panel at a time sits on top of the card: the prompt of a row's hide control
 *  (HIDE_P) or the rules editor (HIDE_ED). */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

export const scriptHide = (_L: CockpitLayout, _n: Num, _q: Str, _hex: Str): string => String.raw`var HIDE=[],HIDE_LISTS=["sessions","runs","timeline","search"],HIDE_N={sessions:0,runs:0,timeline:0,search:0},HIDE_SEEN={sessions:[],runs:[],timeline:[],search:[]};
var HIDE_P=null,HIDE_ED=null,HIDE_ERR="",HIDE_LOADED=false,HIDE_HEADS=[],HIDE_SHOW_KEY="pai.cockpit.hideshow";
var HIDE_TXT={sessions:"sessions",runs:"worker runs",timeline:"timeline",search:"prompt search"};
function hideRe(m){var x=/^\/(.+)\/([a-z]*)$/.exec(m);if(!x)return null;try{return new RegExp(x[1],x[2].indexOf("i")>=0?x[2]:x[2]+"i")}catch(e){return null}}
function hideRuleHits(r,list,text){return r.in.indexOf(list)>=0&&hideText(r,text)}
function hideText(r,text){var re=hideRe(r.match);return re?re.test(text):String(text).toLowerCase().indexOf(String(r.match).toLowerCase())>=0}
function hideIs(list,text){return HIDE.some(function(r){return hideRuleHits(r,list,text)})}
function hideShown(){try{return JSON.parse(localStorage.getItem(HIDE_SHOW_KEY)||"{}")||{}}catch(e){return{}}}
/** Splits items of one list: kept (shown; with show-hidden on also the hidden ones, flagged) and the number hidden. */
function hideFilter(list,items,textOf){
 var show=!!hideShown()[list],seen=[],n=0,out=[];
 items.forEach(function(it){var t=textOf(it),h=hideIs(list,t);seen.push(t);if(h){n++;if(show)out.push({it:it,hidden:true})}else out.push({it:it,hidden:false})});
 HIDE_SEEN[list]=seen;HIDE_N[list]=n;hidePaintHeads();
 return out;
}
/** A suggested pattern: a run label loses its trailing date/counter segments; a title or prompt keeps its first words. */
function hideSuggest(list,text){
 var t=String(text||"").replace(/\s+/g," ").trim();
 if(list==="runs"){var s=t.replace(/([-_ ]\d[\w-]*)+$/,"");return s||t}
 var w=t.replace(/([-_ ]\d[\w-]*)+$/,"").split(" "),k=list==="timeline"||list==="search"?4:2;
 return w.slice(0,k).join(" ")||t;
}
/** The row's hide control: at the row end, visible on hover or focus. list: which list it belongs to; text: what the rules match against. */
function hideBtn(list,text,sugg){
 return'<button type="button" class="hbtn" data-act="hide" data-hl="'+list+'" data-ht="'+esc(sugg||text)+'" title="hide rows like this" aria-label="hide rows like this">⊘</button>';
}
function hideRedraw(){if(typeof Win!=="undefined"&&typeof data!=="undefined"&&data)Win.update("data",data);hidePaintHeads()}
function hideLoad(){
 fetch("/cockpit/hide",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){HIDE=j.rules||[];HIDE_LOADED=true;hideRedraw()},function(){});
}
/** Persists the whole list; on refusal the server's message shows in the panel and the list stays as it was. */
function hidePost(rules,done){
 fetch("/cockpit/hide",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rules:rules}),cache:"no-store"}).then(function(r){return r.json().then(function(j){return{ok:r.ok&&j.ok,j:j}})}).then(function(x){
  if(x.ok){HIDE=x.j.rules;HIDE_ERR="";if(done)done()}else HIDE_ERR=(x.j&&x.j.message)||"not saved";
  hideRedraw();
 },function(e){HIDE_ERR="no answer: "+(e&&e.message?e.message:e);hideRedraw()});
}
/** Header control of a card: "N hidden" (toggles showing them dimmed) and "rules" (opens the editor). */
function hideHeadAction(list){
 return{id:"hide-"+list,label:"hidden",title:"hidden rows",make:function(){
  var w=document.createElement("span");w.className="wsearch";
  var a=document.createElement("button");a.type="button";a.className="cbtn";a.setAttribute("data-act","hideshow");a.setAttribute("data-hl",list);
  var b=document.createElement("button");b.type="button";b.className="cbtn";b.setAttribute("data-act","hideedit");b.setAttribute("data-hl",list);b.textContent="rules";b.title="edit the hide rules";b.setAttribute("aria-label","edit the hide rules");
  a.addEventListener("click",function(){var s=hideShown();if(s[list])delete s[list];else s[list]=1;try{localStorage.setItem(HIDE_SHOW_KEY,JSON.stringify(s))}catch(e){}hideRedraw()});
  b.addEventListener("click",function(){HIDE_ED=HIDE_ED===list?null:list;HIDE_P=null;HIDE_ERR="";hideRedraw()});
  w.appendChild(a);w.appendChild(b);HIDE_HEADS.push({list:list,el:w,a:a});hidePaintHeads();
  return w;
 }};
}
function hidePaintHeads(){
 HIDE_HEADS=HIDE_HEADS.filter(function(h){return document.contains(h.el)||!h.painted});
 HIDE_HEADS.forEach(function(h){
  var n=HIDE_N[h.list]+(h.list==="sessions"?0:0),on=!!hideShown()[h.list],t=n+" hidden";
  h.painted=true;
  if(h.a.textContent!==t)h.a.textContent=t;
  h.a.setAttribute("aria-pressed",on?"true":"false");
  var ti=n?(on?"hidden rows are shown dimmed: click to hide them":"click to show the "+n+" hidden "+HIDE_TXT[h.list]+" rows dimmed"):"no row is hidden";
  if(h.a.title!==ti){h.a.title=ti;h.a.setAttribute("aria-label",ti)}
 });
}
/** Inline links "N hidden" for the lists that live inside the sessions card (timeline, search hits). */
function hideNote(list){
 var n=HIDE_N[list];
 if(!n)return"";
 var on=!!hideShown()[list];
 return'<button type="button" class="lnk dim" data-act="hideshow" data-hl="'+list+'" title="'+(on?"hide them again":"show them dimmed")+'">'+n+' hidden'+(on?" (shown)":"")+'</button>';
}
function hideLists(sel){return HIDE_LISTS.map(function(l){return'<button type="button" class="cbtn" data-act="hidelist" data-hl="'+l+'" aria-pressed="'+(sel.indexOf(l)>=0?"true":"false")+'" title="applies to the '+esc(HIDE_TXT[l])+' list">'+esc(HIDE_TXT[l])+'</button>'}).join("")}
/** The panel on top of a card: the prompt of a hide control, or the rules editor. card: "sessions" | "runs". */
function hidePanelHtml(card){
 var err=HIDE_ERR?'<div class="bad hp-e">'+esc(HIDE_ERR)+'</div>':"";
 if(HIDE_P&&HIDE_P.card===card){
  return'<div class="hp"><span class="dim">hide rows like</span><input class="hp-i" type="text" value="'+esc(HIDE_P.pat)+'" data-hide-pat="1" aria-label="pattern: text or /regex/" title="text or /regex/, case-insensitive"><span class="hp-l">'+hideLists(HIDE_P.in)+'</span><button type="button" class="cbtn" data-act="hidesave" title="save the rule">hide</button><button type="button" class="cbtn" data-act="hidecancel" title="cancel">cancel</button>'+err+'</div>';
 }
 if(HIDE_ED===card){
  var rows=HIDE.map(function(r,i){
   var n=0;HIDE_LISTS.forEach(function(l){if(r.in.indexOf(l)>=0)HIDE_SEEN[l].forEach(function(t){if(hideText(r,t))n++})});
   return'<div class="hp-r" data-ri="'+i+'"><input class="hp-i" type="text" value="'+esc(r.match)+'" data-hide-edit="match" aria-label="pattern" title="text or /regex/, case-insensitive"><span class="hp-l">'+HIDE_LISTS.map(function(l){return'<button type="button" class="cbtn" data-act="hideruleList" data-hl="'+l+'" aria-pressed="'+(r.in.indexOf(l)>=0?"true":"false")+'" title="applies to the '+esc(HIDE_TXT[l])+' list">'+esc(HIDE_TXT[l])+'</button>'}).join("")+'</span><input class="hp-i hp-note" type="text" value="'+esc(r.note||"")+'" data-hide-edit="note" aria-label="note" title="why this rule exists" placeholder="note"><span class="dim hp-c" title="rows this rule hides now">hides '+n+'</span><button type="button" class="cbtn" data-act="hidedel" title="delete this rule">delete</button></div>';
  }).join("");
  return'<div class="hp hp-ed"><b>Hidden</b>'+(rows||'<span class="dim">no rules: use the ⊘ at the end of a row</span>')+'<button type="button" class="cbtn" data-act="hideedit" data-hl="'+card+'" title="close the editor">close</button>'+err+'</div>';
 }
 return"";
}
/** Click and change wiring of a card body (registered before the card's own row handler, which a click on a hide control must not reach). */
function hideWire(ctx,card){
 ctx.body.addEventListener("click",function(e){
  var t=e.target&&e.target.closest?e.target.closest("[data-act^=hide],.hbtn"):null;
  if(!t||!ctx.body.contains(t))return;
  var act=t.getAttribute("data-act");
  if(act==="hideshow"&&t.closest(".chead"))return;
  e.preventDefault();e.stopImmediatePropagation();
  if(act==="hide"){var l=t.getAttribute("data-hl");HIDE_P={card:card,list:l,pat:t.getAttribute("data-ht"),in:[l]};HIDE_ED=null;HIDE_ERR="";return hideRedraw()}
  if(act==="hidelist"){var k=t.getAttribute("data-hl"),i=HIDE_P.in.indexOf(k);if(i>=0)HIDE_P.in.splice(i,1);else HIDE_P.in.push(k);return hideRedraw()}
  if(act==="hidecancel"){HIDE_P=null;HIDE_ERR="";return hideRedraw()}
  if(act==="hidesave"){
   var rule={match:HIDE_P.pat.trim(),in:HIDE_LISTS.filter(function(x){return HIDE_P.in.indexOf(x)>=0})};
   if(!rule.match){HIDE_ERR="the pattern is empty";return hideRedraw()}
   if(!rule.in.length){HIDE_ERR="pick at least one list";return hideRedraw()}
   return hidePost(HIDE.concat([rule]),function(){HIDE_P=null});
  }
  if(act==="hideedit"){HIDE_ED=null;HIDE_ERR="";return hideRedraw()}
  if(act==="hideshow"){var s=hideShown(),h=t.getAttribute("data-hl");if(s[h])delete s[h];else s[h]=1;try{localStorage.setItem(HIDE_SHOW_KEY,JSON.stringify(s))}catch(x){}return hideRedraw()}
  var row=t.closest("[data-ri]"),ri=row?Number(row.getAttribute("data-ri")):-1;
  if(ri<0)return;
  var next=HIDE.map(function(r){return{match:r.match,in:r.in.slice(),note:r.note}});
  if(act==="hidedel")next.splice(ri,1);
  else if(act==="hideruleList"){var lk=t.getAttribute("data-hl"),j=next[ri].in.indexOf(lk);if(j>=0)next[ri].in.splice(j,1);else next[ri].in.push(lk);if(!next[ri].in.length){HIDE_ERR="a rule needs at least one list: delete it instead";return hideRedraw()}}
  hidePost(next);
 },true);
 ctx.body.addEventListener("input",function(e){var t=e.target;if(t&&t.hasAttribute&&t.hasAttribute("data-hide-pat")&&HIDE_P)HIDE_P.pat=t.value});
 ctx.body.addEventListener("change",function(e){
  var t=e.target,f=t&&t.getAttribute?t.getAttribute("data-hide-edit"):null,row=f&&t.closest("[data-ri]");
  if(!f||!row)return;
  var ri=Number(row.getAttribute("data-ri")),next=HIDE.map(function(r){return{match:r.match,in:r.in.slice(),note:r.note}});
  next[ri][f]=t.value.trim();if(f==="note"&&!next[ri].note)delete next[ri].note;
  hidePost(next);
 });
 ctx.body.addEventListener("keydown",function(e){
  var t=e.target;
  if(e.key==="Enter"&&t&&t.hasAttribute&&t.hasAttribute("data-hide-pat")){e.preventDefault();var b=ctx.body.querySelector("[data-act=hidesave]");if(b)b.click()}
  else if(e.key==="Escape"&&HIDE_P){HIDE_P=null;HIDE_ERR="";hideRedraw()}
 });
}
`;
