/** cockpit-page/win — `workers`: the queue section on the win runtime.
 *  Page-scope ES5 (after scriptCore: esc/table in scope), needs `Win`, `WinT`, `WinA` and `loadQueue`. Feed `queue`
 *  (/cockpit/queue). Group `workers`: the `note` cards `workers.local` / `workers.wt` (local-model and worktrees lines) and one
 *  dynamic `table` card per block, added by data through Win.addCards: `workers.plans|panes|violations|tests|builds`,
 *  `workers.prov:<provider>` (a serialising provider) and `workers.sess:<session>`. `next`/`up` are row buttons that run
 *  the registered queue.next / queue.up actions (/cockpit/queue/<verb>); the result is the table card's status. Waiting
 *  rows of a serialising provider drag-reorder as a row-level HTML5 drag inside their card (queue.move); while a row
 *  drag is active in a card that card is not repainted (WK_DRAG, the card.busyDrag of the spec). The `table`/`note` types
 *  are the generic types of win/types.ts; the cards here only carry views (wkTableView / wkLocalView / wkWtView). */

export const WIN_WORKERS_JS = String.raw`var WK_INFO="Workers by the session that started them, then by model. A serialising provider (cap 1, e.g. the local model) has its own block on top: its queue is shared across sessions. Drag a waiting row (or use next / up) to reorder it; running workers are never interrupted.";
var WK_BTN='<button type="button" data-q="next" data-id="@" title="runs next; the running worker is not interrupted">next</button> <button type="button" data-q="up" data-id="@" title="move one place up">up</button>';
var WK_LEVELS=["high","normal","low"];
/** A running worker's engine controls: a priority switch (applies to its next request; no native select in the cockpit) and pause/resume. */
function wkCtl(it){
 var id=esc(it.id),cur=it.priority||"normal",seg=WK_LEVELS.map(function(l){return'<button type="button" data-act="worker.priority" data-wp="'+l+'" data-id="'+id+'" aria-pressed="'+(cur===l)+'"'+(cur===l?' class="on" style="font-weight:700;text-decoration:underline"':'')+' title="'+l+' priority at the engine; applies to the next request">'+l+'</button>'}).join(" ");
 return seg+' <button type="button" data-act="worker.'+(it.paused?"resume":"pause")+'" data-wk="'+(it.paused?"resume":"pause")+'" data-id="'+id+'" title="'+(it.paused?"release the parked request":"park its next engine request; the running one finishes")+'">'+(it.paused?"resume":"pause")+'</button>';
}
/** State text of a running row: paused, waiting for the engine, or running. */
function wkState(it,idle){return it.paused?"paused":it.engineWaitSec?"waiting for engine "+wkDur(it.engineWaitSec):idle?"idle session":"running"}
var WK_NONE='<span class="dim">nothing running or waiting</span>';
var WQ=null,WK_BLOCKS={},WK_DRAG=null;
function wkDur(s){return s<90?s+"s":s<5400?Math.floor(s/60)+"m"+String(s%60).padStart(2,"0")+"s":Math.floor(s/3600)+"h"+String(Math.floor(s%3600/60)).padStart(2,"0")+"m"}
function wkSpan(t){return' <span title="'+esc(t)+'">'+esc(t)+'</span>'}
/** One provider/session row. serial = a cap-1 provider (its waiting rows drag). The row attrs ride on the first cell: table() builds the tr. */
function wkRow(it,p,waiting,serial){
 var idle=!waiting&&it.ageSec>86400,mdl=p.provider+"/"+(it.model||"?");
 var cells=[waiting?String(it.position):"",(waiting&&serial?'<span class="grip" title="drag to reorder">&#8942;&#8942;</span>':'')+'<span title="'+esc(it.id+" · "+it.label)+'">'+esc(it.label||it.id)+'</span>'];
 cells.push(serial?wkSpan(it.session||"other"):wkSpan(mdl));
 cells.push(waiting?'waiting'+(it.priority&&it.priority!=='normal'?' ('+esc(it.priority)+')':''):esc(wkState(it,idle))+(it.priority&&it.priority!=='normal'?' ('+esc(it.priority)+')':''),wkDur(waiting?it.waitedSec:it.ageSec),waiting?'':esc(idle?"":it.now||""),waiting?WK_BTN.split("@").join(esc(it.id)):idle?"":wkCtl(it));
 var drag=waiting&&serial;
 cells[0]='<span class="'+(idle?'dim':'')+'"'+(drag?' data-qrow="1" data-id="'+esc(it.id)+'" data-prov="'+esc(p.provider)+'" data-pos="'+it.position+'"':"")+'>'+cells[0]+'</span>';
 return cells;
}
function wkCmp(a,b){return a==="other"?1:b==="other"?-1:a<b?-1:a>b?1:0}
function wkBuildRow(b,i){var l=wkSpan(b.label+(b.mode==="full"?" [full]":"")+(b.key?" ["+b.key+"]":""));return[b.state==="running"?"":String(i+1),l,wkSpan(b.session),b.state==="running"?"running":"waiting"+(b.why?" ("+esc(b.why)+")":""),wkDur(b.state==="running"?b.ageSec:b.waitedSec)]}
/** The queue payload as blocks: [{id, title (plain text), head, rows}] in page order. */
function wkBlocks(q){
 var out=[],sess={},ps=(q.providers||[]).filter(function(p){return p.running.length||p.waiting.length}),pl=q.plans||[],pv=q.paneViolations||[],pn=q.panes||[],bq=q.builds;
 if(pl.length)out.push({id:"plans",title:"plans",head:["plan .txt","parts","phase .txt","in phase","running .txt","workers .txt"],rows:pl.map(function(p){return[wkSpan(p.job),p.merged+'/'+p.total,wkSpan(p.phase),wkDur(p.phaseSec),wkDur(p.ageSec),wkSpan((p.running||[]).join(", "))]})});
 if(pn.length)out.push({id:"panes",title:"panes",head:["label .txt","cwd .txt","running","log .txt"],rows:pn.map(function(p){return[wkSpan(p.label),wkSpan(p.cwd),wkDur(p.ageSec),wkSpan(p.log)]})});
 if(pv.length)out.push({id:"violations",title:"pane violations",head:["process .txt","mark .txt","why .txt"],rows:pv.map(function(p){return[wkSpan(p.id),wkSpan(p.mark),wkSpan(p.why||"")]})});
 if(bq&&(bq.running.length||bq.waiting.length))[["test","tests",bq.testSlots],["build","builds",bq.slots]].forEach(function(P){
  var run=bq.running.filter(function(b){return b.kind===P[0]}).map(function(b){b.state="running";return b}),wt=bq.waiting.filter(function(b){return b.kind===P[0]}).map(function(b){b.state="waiting";return b});
  if(!run.length&&!wt.length)return;
  out.push({id:P[1],title:P[1]+" ("+P[2]+" slot"+(P[2]===1?"":"s")+")",head:["pos","build .txt","session .txt","state","waited"],rows:run.concat(wt).map(wkBuildRow)});
 });
 ps.forEach(function(p){
  if(p.cap===1){
   var mods={};p.running.concat(p.waiting).forEach(function(x){if(x.model)mods[x.model]=1});
   var ms=Object.keys(mods).join(", ");
   out.push({id:"prov:"+p.provider,title:p.provider+(ms?": "+ms:"")+" (slots "+p.running.length+"/1"+(p.conversationSlots?", conversation slots "+p.conversationSlots:"")+")",head:["pos","worker .txt","session .txt","state","waited","now","move"],
    rows:p.running.map(function(r){return wkRow(r,p,false,true)}).concat(p.waiting.map(function(w){return wkRow(w,p,true,true)})),foot:p.waiting.length?"":"nothing waiting"});
   return}
  p.running.forEach(function(r){(sess[r.session||"other"]=sess[r.session||"other"]||[]).push({k:p.provider+"/"+(r.model||"?"),h:wkRow(r,p,false,false)})});
  p.waiting.forEach(function(w){(sess[w.session||"other"]=sess[w.session||"other"]||[]).push({k:p.provider+"/"+(w.model||"?"),h:wkRow(w,p,true,false)})});
 });
 Object.keys(sess).sort(wkCmp).forEach(function(s){
  var it=sess[s].sort(function(a,b){return a.k<b.k?-1:a.k>b.k?1:0}),cnt={};
  it.forEach(function(x){cnt[x.k]=(cnt[x.k]||0)+1});
  out.push({id:"sess:"+s,title:s+((q.sessionMax||{})[s]?" · max "+q.sessionMax[s]+" at a time":"")+" · "+Object.keys(cnt).map(function(k){return k+" ×"+cnt[k]}).join(", "),head:["pos","worker .txt","model .txt","state","waited","now","move"],rows:it.map(function(x){return x.h})});
 });
 return out;
}
function wkBlockOf(id){return WK_BLOCKS[id]||null}
/** A block's card html: the table (plus its footnote); a block that is gone says so. */
function wkBlockHtml(b){
 if(!b)return WK_NONE;
 return table(b.head,b.rows)+(b.foot?'<div class="dim" style="text-align:left">'+esc(b.foot)+'</div>':"");
}
/** Make the waiting rows of a card draggable (after every repaint; the morph does not carry the attribute). */
function wkMarkRows(body){
 var rs=body.querySelectorAll("[data-qrow]"),i,tr;
 for(i=0;i<rs.length;i++){tr=rs[i].closest("tr");if(tr&&tr.getAttribute("draggable")!=="true")tr.setAttribute("draggable","true")}
}
function wkHost(){return{fetch:WIN_HOST.fetch,setStatus:WIN_HOST.setStatus,setBusy:WIN_HOST.setBusy,clearStatus:WIN_HOST.clearStatus,refresh:function(f){if(f&&f.indexOf("queue")>=0&&typeof loadQueue==="function")loadQueue()},announce:WIN_HOST.announce}}
/** The queue routes answer {ok:true,...} without a message: the card status says what was done. */
function wkRun(ctx,verb,args,el,done){
 return WinA.runAction(ctx.id,"queue."+verb,args,el,wkHost()).then(function(r){if(r.ok&&!r.message)ctx.status("ok",done);return r});
}
/** The engine-control actions (worker.priority / worker.pause / worker.resume) through the registered action verbs. */
function wkCtlRun(ctx,verb,id,value,el){
 var args={target:id};if(value!==undefined)args.value=value;
 return WinA.runAction(ctx.id,verb,args,el,wkHost());
}
function wkRowInfo(tr){var s=tr&&tr.querySelector("[data-qrow]");return s?{id:s.getAttribute("data-id"),prov:s.getAttribute("data-prov"),pos:Number(s.getAttribute("data-pos"))}:null}
/** The card's delegated wiring, once: next/up buttons -> runAction, row drag -> queue.move. */
function wkWire(ctx){
 var body=ctx.body,from=null;
 body.addEventListener("click",function(e){
  var cb=e.target&&e.target.closest?e.target.closest("button[data-wk]"):null;
  if(cb){wkCtlRun(ctx,"worker."+cb.getAttribute("data-wk"),cb.getAttribute("data-id"),undefined,cb);return}
  var pb=e.target&&e.target.closest?e.target.closest("button[data-wp]"):null;
  if(pb){if(pb.getAttribute("aria-pressed")!=="true")wkCtlRun(ctx,"worker.priority",pb.getAttribute("data-id"),pb.getAttribute("data-wp"),pb);return}
  var b=e.target&&e.target.closest?e.target.closest("button[data-q]"):null;
  if(!b)return;
  var v=b.getAttribute("data-q");
  wkRun(ctx,v,{id:b.getAttribute("data-id")},b,v==="next"?"moved to next":"moved up one place");
 });
 body.addEventListener("dragstart",function(e){
  var tr=e.target&&e.target.closest?e.target.closest("tr"):null,r=wkRowInfo(tr);
  if(!r)return;
  from=r;WK_DRAG=ctx.id;tr.style.opacity=".4";
  if(e.dataTransfer){e.dataTransfer.effectAllowed="move";try{e.dataTransfer.setData("text/plain",r.id)}catch(x){}}
 });
 body.addEventListener("dragover",function(e){
  var tr=e.target&&e.target.closest?e.target.closest("tr"):null,r=wkRowInfo(tr);
  if(from&&r&&r.prov===from.prov){e.preventDefault();tr.style.outline="1px solid var(--acc)"}
 });
 body.addEventListener("dragleave",function(e){var tr=e.target&&e.target.closest?e.target.closest("tr"):null;if(tr)tr.style.outline=""});
 body.addEventListener("drop",function(e){
  var tr=e.target&&e.target.closest?e.target.closest("tr"):null,r=wkRowInfo(tr);
  if(tr)tr.style.outline="";
  if(!from||!r||r.id===from.id||r.prov!==from.prov)return;
  e.preventDefault();
  wkRun(ctx,"move",{id:from.id,position:r.pos},null,"moved to place "+r.pos);
 });
 body.addEventListener("dragend",function(e){
  var tr=e.target&&e.target.closest?e.target.closest("tr"):null;
  if(tr){tr.style.opacity="";tr.style.outline=""}
  from=null;WK_DRAG=null;
  if(WQ)Win.update("queue",WQ);
 });
}
function wkTableView(q,ctx){
 if(!q||!q.providers||WK_DRAG===ctx.id)return null;
 var b=wkBlockOf(ctx.id.slice(8));
 return{title:b?b.title:undefined,html:wkBlockHtml(b),after:function(c){
  if(!c.body.__wk){c.body.__wk=1;wkWire(c)}
  wkMarkRows(c.body);fitTables(c.body);
 }};
}
function wkLocalView(q){return q&&q.providers?{text:q.localModel||"no local model reported",title:q.localModelTitle||null}:null}
function wkWtView(q){return q&&q.providers?{text:q.worktrees||"no worktrees reported"}:null}
/** The block cards, added by data (a structural change); a block already in the layout is only built. */
function wkSync(q){
 var bl=wkBlocks(q),specs=[],rows=[],i;
 WK_BLOCKS={};
 for(i=0;i<bl.length;i++){
  WK_BLOCKS[bl[i].id]=bl[i];
  specs.push({id:"workers."+bl[i].id,type:"table",title:bl[i].title,feeds:["queue"],view:wkTableView});
  rows.push(["workers."+bl[i].id]);
 }
 if(specs.length&&Win.addCards("workers",specs,rows))Win.update("queue",q);
}
/** The queue feed: keep the payload, compute the blocks, add cards for new ones, then paint. */
function winFeedQueue(q){
 if(!q||!q.providers)return;
 WQ=q;wkSync(q);Win.update("queue",q);
}
function workersDefaults(){
 return{tree:WinT.leaf("workers"),stDefaults:{},kids:{workers:WinT.split("c",[WinT.leaf("workers.local"),WinT.leaf("workers.wt")],[0.5,0.5])},
  cards:[{id:"workers",type:"group",title:"Workers — running and waiting",info:WK_INFO},{id:"workers.local",type:"note",title:"local model",feeds:["queue"],view:wkLocalView},{id:"workers.wt",type:"note",title:"worktrees",feeds:["queue"],view:wkWtView}]};
}
`;
