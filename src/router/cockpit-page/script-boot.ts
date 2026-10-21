/** cockpit-page — script tail: pool panel, queue, theme, startup wiring and polling. */

import { POOL_PANEL_JS } from "../pool-panel.js";
import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** Pool panel JS through the closing html tags. */
export const scriptBoot = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`${POOL_PANEL_JS}
var qdrag=false;
function renderQueue(q){
 if(qdrag)return;
 var el=$("queuepanel");if(!q){if(!el.__html)setHtml(el,'<span class="dim">queue status unavailable</span>');return}
 function qdur(s){return s<90?s+"s":s<5400?Math.floor(s/60)+"m"+String(s%60).padStart(2,"0")+"s":Math.floor(s/3600)+"h"+String(Math.floor(s%3600/60)).padStart(2,"0")+"m"}
 setTip($("queuetip"),"Workers by the session that started them, then by model. A serialising provider (cap 1, e.g. the local model) has its own block on top: its queue is shared across sessions. Drag a waiting row (or use next / up) to reorder it; running workers are never interrupted.");
 var ps=(q.providers||[]).filter(function(p){return p.running.length||p.waiting.length});
 var pl=q.plans||[];
 var bq=q.builds,bhas=bq&&(bq.running.length||bq.waiting.length);
 var wt=q.worktrees?'<div class="dim">'+esc(q.worktrees)+'</div>':'';
 if(!ps.length&&!bhas&&!pl.length){setHtml(el,'<span class="dim">nothing running or waiting</span>'+wt);return}
 var BTN='<button data-q="next" data-id="@" title="runs next; the running worker is not interrupted">next</button> <button data-q="up" data-id="@" title="move one place up">up</button>';
 function mk(it,p,waiting,serial){
  var idle=!waiting&&it.ageSec>86400,mdl=esc(p.provider+"/"+(it.model||"?"));
  var cells=[waiting?String(it.position):"",(waiting&&serial?'<span class="grip" title="drag to reorder">&#8942;&#8942;</span>':'')+'<span title="'+esc(it.id+" · "+it.label)+'">'+esc(it.label||it.id)+'</span>'];
  if(serial)cells.push(' <span title="'+esc(it.session||"other")+'">'+esc(it.session||"other")+'</span>');else cells.push(' <span title="'+mdl+'">'+mdl+'</span>');
  cells.push(waiting?'waiting':idle?'idle session':'running',qdur(waiting?it.waitedSec:it.ageSec),waiting?'':esc(idle?"":it.now||""),waiting?BTN.split("@").join(esc(it.id)):"");
  var drag=waiting&&serial;
  // the row attrs ride on the first cell: table() builds the <tr>, the drag wiring finds the row via closest("tr")
  cells[0]='<span class="'+(idle?'dim':'')+'"'+(drag?' data-qrow="1" draggable="true" data-id="'+esc(it.id)+'" data-prov="'+esc(p.provider)+'" data-pos="'+it.position+'"':"")+'>'+cells[0]+'</span>';
  return cells;
 }
 function block(title,head,rows){return'<div style="margin-bottom:10px"><div style="margin-bottom:2px"><b>'+title+'</b></div>'+table(head,rows)+'</div>'}
 var out=[],sess={};
 ps.forEach(function(p){
  if(p.cap===1){
   var rows=p.running.map(function(r){return mk(r,p,false,true)}).concat(p.waiting.map(function(w){return mk(w,p,true,true)}));
   var mods={};p.running.concat(p.waiting).forEach(function(x){if(x.model)mods[x.model]=1});
   out.push(block(esc(p.provider)+(Object.keys(mods).length?': '+esc(Object.keys(mods).join(", ")):'')+' (slots '+p.running.length+'/1'+(p.conversationSlots?', conversation slots '+p.conversationSlots:'')+')',["pos","worker .txt","session .txt","state","waited","now","move"],rows));
   if(!p.waiting.length)out.push('<div class="dim" style="text-align:left">nothing waiting</div>');
   return}
  p.running.forEach(function(r){(sess[r.session||"other"]=sess[r.session||"other"]||[]).push({k:p.provider+"/"+(r.model||"?"),h:mk(r,p,false,false)})});
  p.waiting.forEach(function(w){(sess[w.session||"other"]=sess[w.session||"other"]||[]).push({k:p.provider+"/"+(w.model||"?"),h:mk(w,p,true,false)})});
 });
 Object.keys(sess).sort(function(a,b){return a==="other"?1:b==="other"?-1:a<b?-1:a>b?1:0}).forEach(function(s){
  var it=sess[s].sort(function(a,b){return a.k<b.k?-1:a.k>b.k?1:0}),cnt={};it.forEach(function(x){cnt[x.k]=(cnt[x.k]||0)+1});
  out.push(block(esc(s)+((q.sessionMax||{})[s]?' <span class="dim">max '+q.sessionMax[s]+' at a time</span> ':'')+' <span class="dim">'+Object.keys(cnt).map(function(k){return esc(k)+" ×"+cnt[k]}).join(", ")+'</span>',["pos","worker .txt","model .txt","state","waited","now","move"],it.map(function(x){return x.h})))
 });
 if(bhas){
  [["test","tests",bq.testSlots],["build","builds",bq.slots]].forEach(function(P){
   var run=bq.running.filter(function(b){return b.kind===P[0]}),wt=bq.waiting.filter(function(b){return b.kind===P[0]});
   if(!run.length&&!wt.length)return;
   var brow=run.map(function(b){return["",' <span title="'+esc(b.session)+'">'+esc(b.label)+(b.mode==="full"?' [full]':'')+(b.key?' ['+esc(b.key)+']':'')+'</span>',' <span title="'+esc(b.session)+'">'+esc(b.session)+'</span>','running',qdur(b.ageSec)]}).concat(wt.map(function(b,i){return[String(i+1),' <span title="'+esc(b.session)+'">'+esc(b.label)+(b.mode==="full"?' [full]':'')+(b.key?' ['+esc(b.key)+']':'')+'</span>',' <span title="'+esc(b.session)+'">'+esc(b.session)+'</span>','waiting'+(b.why?' ('+esc(b.why)+')':''),qdur(b.waitedSec)]}));
   out.unshift(block(P[1]+' ('+P[2]+' slot'+(P[2]===1?'':'s')+')',["pos","build .txt","session .txt","state","waited"],brow));
  });
 }
 if(pl.length)out.unshift(block("plans",["plan .txt","parts","phase .txt","in phase","running .txt","workers .txt"],pl.map(function(p){return[' <span title="'+esc(p.job)+'">'+esc(p.job)+'</span>',p.merged+'/'+p.total,' <span title="'+esc(p.phase)+'">'+esc(p.phase)+'</span>',qdur(p.phaseSec),qdur(p.ageSec),' <span title="'+esc((p.running||[]).join(", "))+'">'+esc((p.running||[]).join(", "))+'</span>']})));
 var pv=q.paneViolations||[];
 if(pv.length)out.unshift(block("pane violations",["process .txt","mark .txt","why .txt"],pv.map(function(p){return[' <span title="'+esc(p.id)+'">'+esc(p.id)+'</span>',' <span title="'+esc(p.mark)+'">'+esc(p.mark)+'</span>',' <span title="'+esc(p.why||"")+'">'+esc(p.why||"")+'</span>']})));
 var pn=q.panes||[];
 if(pn.length)out.unshift(block("panes",["label .txt","cwd .txt","running","log .txt"],pn.map(function(p){return[' <span title="'+esc(p.label)+'">'+esc(p.label)+'</span>',' <span title="'+esc(p.cwd)+'">'+esc(p.cwd)+'</span>',qdur(p.ageSec),' <span title="'+esc(p.log)+'">'+esc(p.log)+'</span>']})));
 if(q.localModel)out.unshift('<div class="dim" style="margin:4px 0"'+(q.localModelTitle?' title="'+esc(q.localModelTitle)+'"':"")+'>'+esc(q.localModel)+"</div>");
 setHtml(el,out.join("")+wt);
 function post(verb,body){
  fetch("/cockpit/queue/"+verb,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),cache:"no-store"})
   .then(function(r){return r.json()}).then(function(j){if(j.error)setTip($("queuetip"),j.error);loadQueue()}).catch(function(){loadQueue()});
 }
 var bs=el.querySelectorAll("button[data-q]");
 for(var i=0;i<bs.length;i++)bs[i].onclick=function(){this.disabled=true;post(this.getAttribute("data-q"),{id:this.getAttribute("data-id")})};
 var rs=el.querySelectorAll("[data-qrow]"),from=null;
 for(var k=0;k<rs.length;k++){(function(sp){
  var tr=sp.closest?sp.closest("tr"):null;if(!tr)return;
  tr.ondragstart=function(e){qdrag=true;from=tr;from.__prov=prov;tr.style.opacity=".4";if(e.dataTransfer){e.dataTransfer.effectAllowed="move";try{e.dataTransfer.setData("text/plain",id)}catch(x){}}};
  var prov=sp.getAttribute("data-prov"),id=sp.getAttribute("data-id"),pos=Number(sp.getAttribute("data-pos"));
  tr.__prov=prov;
  if(sp.getAttribute("draggable"))tr.setAttribute("draggable","true");
  tr.ondragover=function(e){if(from&&from.__prov===prov){e.preventDefault();tr.style.outline="1px solid var(--acc)"}};
  tr.ondragleave=function(){tr.style.outline=""};
  tr.ondrop=function(e){e.preventDefault();tr.style.outline="";if(!from||from===tr||from.__prov!==prov)return;post("move",{id:id,position:pos})};
  tr.ondragend=function(){from=null;qdrag=false;tr.style.opacity="";loadQueue()};
 })(rs[k])}
}
/** Hold-last-good, for every endpoint: the last good payload stays on screen over a failed fetch (network, timeout,
 *  non-2xx) or a payload the server marks degraded (stale:{since,reason}) until HOLD_MS has passed since the last good
 *  one; the section header carries a "stale" marker meanwhile, then the error state. A good payload — real changes
 *  included — is applied at once and clears the marker. */
var HOLD_MS=${n(L.holdLastGoodSecs)}*1000,FETCH_MS=${n(L.holdLastGoodSecs)}*250,goodAt={},bootAt=Date.now();
function staleMark(secs,key,txt,err){
 for(var i=0;i<secs.length;i++){
  var sec=document.querySelector('section[data-section="'+secs[i]+'"]');if(!sec)continue;
  var h=sec.querySelector("h2"),m=sec.querySelector('.stalemark[data-sk="'+key+'"]');
  if(!txt){if(m)m.remove();sec.classList.remove("sec-err");continue}
  if(!m&&h){m=document.createElement("span");m.className="stalemark";m.setAttribute("data-sk",key);h.appendChild(m)}
  if(m){m.textContent=txt;m.className="stalemark"+(err?" err":"")}
  if(err)sec.classList.add("sec-err");else sec.classList.remove("sec-err");
 }
}
function pull(key,url,secs,apply,onErr){
 var ctl=typeof AbortController!=="undefined"?new AbortController():null,tm=ctl?setTimeout(function(){ctl.abort()},FETCH_MS):0;
 function hold(why){
  var age=Math.round((Date.now()-(goodAt[key]||bootAt))/1000);
  if(Date.now()-(goodAt[key]||bootAt)<HOLD_MS){if(goodAt[key])staleMark(secs,key,"stale · "+age+" s · "+why,false);return}
  staleMark(secs,key,"error · "+age+" s · "+why,true);if(onErr)onErr(why);
 }
 fetch(url,ctl?{cache:"no-store",signal:ctl.signal}:{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("http "+r.status);return r.json()}).then(function(j){
  clearTimeout(tm);
  if(j&&j.stale){
   if(goodAt[key]){hold(j.stale.reason||"degraded");return}
   apply(j);staleMark(secs,key,"stale · "+(j.stale.reason||"degraded"),false);return;
  }
  goodAt[key]=Date.now();lastOk=goodAt[key];staleMark(secs,key,"",false);apply(j);
 }).catch(function(e){clearTimeout(tm);hold(e&&e.name==="AbortError"?"timeout":e&&e.message&&e.message.indexOf("http ")===0?e.message:"network error")});
}
function loadQueue(){pull("queue","/cockpit/queue",["workers"],function(j){renderQueue(j)},function(){var el=$("queuepanel");if(!qdrag)setHtml(el,'<span class="dim">queue status unavailable</span>')})}
function loadModels(){pull("models","/cockpit/models",["models"],function(j){mdl=j;renderLimits();renderModels()})}
function loadLimits(){pull("limits","/cockpit/limits",["cloud"],function(j){lim=j;renderLimits();renderRouting();if(sys)renderSystem();renderDonuts()})}
function tabs(){var b=document.querySelectorAll("#tabs button");for(var i=0;i<b.length;i++){b[i].className=b[i].getAttribute("data-w")===win?"on":"";b[i].onclick=function(){win=this.getAttribute("data-w");localStorage.setItem("cockpitWin",win);tabs();load();loadSystem()}}}
/** Theme: the system's until the user picks one (only a click is saved); the button shows the other mode. */
function setTheme(t){document.documentElement.dataset.theme=t;var b=$("theme"),l=t==="dark"?"Light mode":"Dark mode";b.title=l;b.setAttribute("aria-label",l)}
$("theme").onclick=function(){var t=document.documentElement.dataset.theme==="dark"?"light":"dark";setTheme(t);try{localStorage.setItem("pai.cockpit.theme",t)}catch(e){}};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(e){var s=null;try{s=localStorage.getItem("pai.cockpit.theme")}catch(err){}if(!s)setTheme(e.matches?"dark":"light")});
setTheme(document.documentElement.dataset.theme==="dark"?"dark":"light");
/* a section that is not on the page fetches nothing */
var needData=has("kpis","tokens","cache","speed","pause","sessions","runs","daily"),needSys=has("system","tokens","cache","cloud"),needLim=has("cloud","routing","models","system","cache"),needModels=has("models"),needPool=has("pool"),needQueue=has("workers"),needMemory=has("memory");
tabs();applyCollapse();applyLayout(layoutRows(document.querySelectorAll("section[data-section]")));secGrips();
/** Row stacking follows the live main width (ResizeObserver, else a resize listener). */
if(typeof ResizeObserver!=="undefined"){try{new ResizeObserver(function(){stackRows();fitTables()}).observe(document.querySelector("main"))}catch(e){}}
window.addEventListener("resize",function(){stackRows();fitTables()});
/** Chart redraw follows the container width (the svg draws at real pixels — see chartW). */
if(typeof ResizeObserver!=="undefined"){try{new ResizeObserver(chartResize).observe(document.querySelector("main"))}catch(e){}}
window.addEventListener("resize",chartResize);
$("reset").onclick=resetLayout;
if(needData)load();if(needSys)loadSystem();if(needLim)loadLimits();if(needModels)loadModels();if(needPool)loadPool();if(needQueue)loadQueue();if(needMemory)loadMemory();
if(needData&&needSys)setInterval(function(){load();loadSystem()},${L.pollMs});else if(needData)setInterval(load,${L.pollMs});else if(needSys)setInterval(loadSystem,${L.pollMs});if(needLim)setInterval(loadLimits,${L.limitsPollMs});if(needModels)setInterval(loadModels,${L.pollMs});if(needPool)setInterval(loadPool,${L.poolPollMs});if(needQueue)setInterval(loadQueue,${L.pollMs});if(needMemory)setInterval(loadMemory,${L.memoryPollMs});setInterval(tick,${L.clockTickMs});
})();
</script></body></html>
`;
