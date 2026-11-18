/** cockpit-page/win — `workers`: the queue section on the win runtime.
 *  Page-scope ES5 (after scriptCore: esc/table in scope), needs `Win`, `WinT`, `WinA` and `loadQueue`. Feed `queue`
 *  (/cockpit/queue). Group `workers`: the `note` cards `workers.local` / `workers.wt` (local-model and worktrees lines) and one
 *  dynamic `table` card per block, added by data through Win.addCards: `workers.plans|panes|violations|tests|builds`,
 *  `workers.prov:<provider>` (a serialising provider) and `workers.sess:<session>`. `next`/`up` are row buttons that run
 *  the registered queue.next / queue.up actions (/cockpit/queue/<verb>); the result is the table card's status. Waiting
 *  rows of a serialising provider drag-reorder as a row-level HTML5 drag inside their card (queue.move); while a row
 *  drag is active in a card that card is not repainted (WK_DRAG, the card.busyDrag of the spec). The `table`/`note` types
 *  are the generic types of win/types.ts; the cards here only carry views (wkTableView / wkLocalView / wkWtView). */

export const WIN_WORKERS_JS = String.raw`var WK_INFO="One table for the whole machine: running jobs first, then the waiting ones in the order they will be admitted. Every button acts on that one job (or on every job of a session) and the state column shows the effect at once.";
var WK_LEVELS=["high","normal","low"];
var WK_EXPLAIN="running = holds a slot; waiting = next in line; paused = parked, its slot is free for the next job; frozen = stopped in memory, lost on reboot; deep-frozen = stopped and saved, survives a reboot. Priority: low = others go first; normal = default; high = ahead of normal; now = front of the queue, pauses all other local jobs while it runs.";
var WK_HEAD=["# .txt","state .txt","activity .txt","prio .txt","session .txt","model .txt","task .txt","time .txt","actions .txt"];
var WK_PTIP={low:"others go first",normal:"default",high:"ahead of normal","now":"front of the queue and pauses all other local jobs while it runs"};
var WK_FILTER=null;
/** One row-level button of the queue table: data-qa = the action, data-id = the job. Deep-freeze is disabled until pai stop/resume exist. */
function wkAct(id,a,label,tip,on){
 var dis=(a==="deep-freeze"||a==="deep-resume")&&!WK_DEEP;
 return'<button type="button" data-qa="'+a+'" data-id="'+esc(id)+'"'+(dis?' disabled title="coming with pai stop/resume"':' title="'+esc(tip)+'"')+(on?' aria-pressed="true" class="on" style="font-weight:700;text-decoration:underline"':'')+'>'+label+'</button>';
}
var WK_DEEP=true;
var WK_LBL={"next":["next","runs next (front of the waiting jobs)"],"up":["up","one place earlier"],"down":["down","one place later"],"pause":["pause","park it; its slot goes to the next job"],"resume":["resume","continue it"],"freeze":["freeze","stop its processes in memory (lost on reboot)"],"thaw":["thaw","continue the frozen processes"],"deep-freeze":["deep-freeze","save its work and stop it; survives a reboot"],"deep-resume":["resume saved","continue from the saved stop"],"to-local":["to local","move the task to the local model"],"to-cloud":["to cloud","move the task to a cloud provider"],"stop":["stop","end this command"]};
function wkTRow(r){
 var acts=r.actions.filter(function(a){return a.indexOf("prio-")!==0}).map(function(a){var l=WK_LBL[a]||[a,a];return wkAct(r.id,a,l[0],l[1])}).join(" ");
 var pr=r.kind==="command"?"":["low","normal","high","now"].map(function(l){return wkAct(r.id,"prio-"+l,l,l+": "+WK_PTIP[l],r.priority===l)}).join(" ");
 var ses='<button type="button" data-qs="'+esc(r.session)+'" title="all jobs of this session: pause / freeze / deep-freeze / resume">'+esc(r.session)+'</button>';
 return[r.slot==="running"?"run":String(r.slot),'<span style="display:inline-block;min-width:13em;white-space:nowrap" title="'+esc(r.detail||"")+'">'+esc(r.stateText)+'</span>','<span style="display:inline-block;min-width:6em;white-space:nowrap" title="'+esc(r.now||"")+'">'+esc(r.activity||"")+'</span>',esc(r.priority),ses,wkSpan(r.model),'<span title="'+esc(r.id+(r.detail?" · "+r.detail:""))+'">'+esc(r.task)+(r.detail?' <span class="dim">'+esc(r.detail)+'</span>':'')+'</span>',wkDur(r.seconds),acts+(pr?" "+pr:"")];
}
/** Session chips above the table + the global actions. */
function wkBar(q){
 var seen={},chips=(q.table||[]).filter(function(r){return!seen[r.session]&&(seen[r.session]=1)}).map(function(r){return'<button type="button" data-qs="'+esc(r.session)+'"'+(WK_FILTER===r.session?' aria-pressed="true" class="on"':'')+' title="show only this session; click again for all">'+esc(r.session)+'</button>'}).join(" ");
 var g=[["freeze","freeze all","stop every worker's processes in memory (lost on reboot)"],["thaw","thaw all","continue all frozen processes"],["deep-freeze","deep-freeze all","pai stop: save all work and stop everything; survives a reboot"],["deep-resume","resume all","pai resume: restore everything saved"]].map(function(x){return'<button type="button" data-qg="'+x[0]+'" title="'+x[2]+'">'+x[1]+'</button>'}).join(" ");
 var sa=WK_FILTER?' <span class="dim">'+esc(WK_FILTER)+' (all its jobs):</span> '+[["pause","pause"],["freeze","freeze"],["deep-freeze","deep-freeze"],["deep-resume","resume saved"],["resume","resume"]].map(function(x){return'<button type="button" data-qx="'+x[0]+'">'+x[1]+'</button>'}).join(" "):"";
 return'<div style="text-align:left">'+g+' <span class="dim">sessions:</span> '+chips+sa+'</div>';
}
var WK_NONE='<span class="dim">nothing running or waiting</span>';
var WQ=null,WK_BLOCKS={},WK_DRAG=null;
function wkDur(s){return s<90?s+"s":s<5400?Math.floor(s/60)+"m"+String(s%60).padStart(2,"0")+"s":Math.floor(s/3600)+"h"+String(Math.floor(s%3600/60)).padStart(2,"0")+"m"}
function wkSpan(t){return' <span title="'+esc(t)+'">'+esc(t)+'</span>'}
function wkCmp(a,b){return a==="other"?1:b==="other"?-1:a<b?-1:a>b?1:0}
function wkBuildRow(b,i){var l=wkSpan(b.label+(b.mode==="full"?" [full]":"")+(b.key?" ["+b.key+"]":""));return[b.state==="running"?"":String(i+1),l,wkSpan(b.session),b.state==="running"?"running":"waiting"+(b.why?" ("+esc(b.why)+")":""),wkDur(b.state==="running"?b.ageSec:b.waitedSec)]}
/** The queue payload as blocks: [{id, title (plain text), head, rows}] in page order. */
function wkBlocks(q){
 var out=[],sess={},pl=q.plans||[],pv=q.paneViolations||[],bq=q.builds;
 if(pl.length)out.push({id:"plans",title:"plans",head:["plan .txt","parts","phase .txt","in phase","running .txt","workers .txt"],rows:pl.map(function(p){return[wkSpan(p.job),p.merged+'/'+p.total,wkSpan(p.phase),wkDur(p.phaseSec),wkDur(p.ageSec),wkSpan((p.running||[]).join(", "))]})});
 if(pv.length)out.push({id:"violations",title:"pane violations",head:["process .txt","mark .txt","why .txt"],rows:pv.map(function(p){return[wkSpan(p.id),wkSpan(p.mark),wkSpan(p.why||"")]})});
 if(bq&&(bq.running.length||bq.waiting.length))[["test","tests",bq.testSlots],["build","builds",bq.slots]].forEach(function(P){
  var run=bq.running.filter(function(b){return b.kind===P[0]}).map(function(b){b.state="running";return b}),wt=bq.waiting.filter(function(b){return b.kind===P[0]}).map(function(b){b.state="waiting";return b});
  if(!run.length&&!wt.length)return;
  out.push({id:P[1],title:P[1]+" ("+P[2]+" slot"+(P[2]===1?"":"s")+")",head:["pos","build .txt","session .txt","state","waited"],rows:run.concat(wt).map(wkBuildRow)});
 });
 if((q.table||[]).length||!out.length)out.unshift({id:"queue",title:"worker queue — "+(q.table||[]).length+" job(s)",head:WK_HEAD,rows:(q.table||[]).map(wkTRow),foot:WK_EXPLAIN,table:true});
 return out;
}
function wkBlockOf(id){return WK_BLOCKS[id]||null}
/** A block's card html: the table (plus its footnote); a block that is gone says so. */
function wkBlockHtml(b){
 if(!b)return WK_NONE;
 if(b.table)return'<div class="dim" style="text-align:left">'+esc(b.foot)+'</div>'+wkBar(WQ||{})+table(b.head,b.rows.filter(function(r){return!WK_FILTER||r[4].indexOf(\'data-qs="\'+esc(WK_FILTER)+\'"\')>=0}));
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
  var qa=e.target&&e.target.closest?e.target.closest("button[data-qa]"):null;
  if(qa){if(!qa.disabled)WinA.runAction(ctx.id,"queue.act",{action:qa.getAttribute("data-qa"),id:qa.getAttribute("data-id")},qa,wkHost());return}
  var qg=e.target&&e.target.closest?e.target.closest("button[data-qg]"):null;
  if(qg){var gv=qg.getAttribute("data-qg");if(gv.indexOf("deep")===0){WinA.runAction(ctx.id,"queue.act",{action:gv,all:true},qg,wkHost());return}(WQ&&WQ.table||[]).forEach(function(r){if(r.kind==="job"&&r.actions.indexOf(qg.getAttribute("data-qg"))>=0)WinA.runAction(ctx.id,"queue.act",{action:qg.getAttribute("data-qg"),id:r.id},qg,wkHost())});return}
  var qs=e.target&&e.target.closest?e.target.closest("button[data-qs]"):null;
  if(qs){var sn=qs.getAttribute("data-qs");WK_FILTER=WK_FILTER===sn?null:sn;if(WQ)Win.update("queue",WQ);return}
  var qx=e.target&&e.target.closest?e.target.closest("button[data-qx]"):null;
  if(qx){if(!qx.disabled)WinA.runAction(ctx.id,"queue.act",{action:qx.getAttribute("data-qx"),session:WK_FILTER},qx,wkHost());return}
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
