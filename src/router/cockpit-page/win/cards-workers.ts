/** cockpit-page/win — `workers`: the queue section on the win runtime.
 *  Page-scope ES5 (after scriptCore: esc/table in scope), needs `Win`, `WinT`, `WinA` and `loadQueue`. Feed `queue`
 *  (/cockpit/queue). Group `workers`: the `note` cards `workers.local` / `workers.wt` (local-model and worktrees lines) and one
 *  dynamic `table` card per block, added by data through Win.addCards: `workers.plans|panes|violations|tests|builds`,
 *  `workers.prov:<provider>` (a serialising provider) and `workers.sess:<session>`. `next`/`up` are row buttons that run
 *  the registered queue.next / queue.up actions (/cockpit/queue/<verb>); the result is the table card's status. Waiting
 *  rows of a serialising provider drag-reorder as a row-level HTML5 drag inside their card (queue.move); while a row
 *  drag is active in a card that card is not repainted (WK_DRAG, the card.busyDrag of the spec). The `table`/`note` types
 *  are the generic types of win/types.ts; the cards here only carry views (wkTableView / wkLocalView / wkWtView). */

export const WIN_WORKERS_JS = String.raw`var WK_INFO="One table for the whole machine: running jobs first, then the waiting ones in the order they will be admitted, then the paused and frozen ones. Every button acts on that one job (or on every job of a session) and the state badge shows the effect at once.";
var WK_EXPLAIN="running = holds a slot; waiting = next in line; paused = parked, its slot is free for the next job; frozen = stopped in memory, lost on reboot; deep-frozen = stopped and saved, survives a reboot. Priority: low = others go first; normal = default; high = ahead of normal; now = front of the queue, pauses all other local jobs while it runs.";
var WK_ACT="Activity: gen = its request is open at the model, the engine is generating its reply; in line = its request waits in the local scheduler queue behind other workers; tool = no request open, a tool (build, test) is running; waiting = waiting for a slot, no request has gone to the model yet; idle Nm = no request at the model and no tool running for N minutes, it may be stuck.";
var WK_COLS=[["state","state",150],["session","session",130],["task","task","40%"],["model","model",110],["prio","prio",90],["time","time r",80],["actions","actions",210]];
var WK_PTIP={low:"others go first",normal:"default",high:"ahead of normal","now":"front of the queue and pauses all other local jobs while it runs"};
var WK_GROUPS=["running","waiting","paused / frozen"];
var WK_BADGE={"running":"wq-run","waiting":"wq-wait","paused":"wq-pause","frozen":"wq-frozen","deep-frozen":"wq-deep"};
var WK_FILTERS=[],WK_TF=[],WK_SORT=null,WK_MENU=null,WK_COPY=null;
/** Filters (session names) and sort ({col,dir}) persist in localStorage. */
function wkLoad(){try{var f=JSON.parse(localStorage.getItem("wqFilter")||"[]"),s=JSON.parse(localStorage.getItem("wqSort")||"null");if(Array.isArray(f))WK_FILTERS=f.filter(function(x){return typeof x==="string"});var tf=JSON.parse(localStorage.getItem("wqTopic")||"[]");if(Array.isArray(tf))WK_TF=tf.filter(function(x){return typeof x==="string"});if(s&&(s.col==="session"||s.col==="state"||s.col==="time"))WK_SORT={col:s.col,dir:s.dir==="desc"?"desc":"asc"}}catch(e){}}
function wkSave(){try{localStorage.setItem("wqFilter",JSON.stringify(WK_FILTERS));localStorage.setItem("wqTopic",JSON.stringify(WK_TF));if(WK_SORT)localStorage.setItem("wqSort",JSON.stringify(WK_SORT));else localStorage.removeItem("wqSort")}catch(e){}}
wkLoad();
/** The one open session (for the session menu): the single active filter, else null. */
function wkOne(){return WK_FILTERS.length===1?WK_FILTERS[0]:null}
/** Filtered by the chosen sessions, then sorted (admission order is the tie-break and the default). */
/** The short id (last dash-part) in grey under the task; computed here so every view has it. */
function wkSid(r){r.sid=String(r.id).slice(String(r.id).lastIndexOf("-")+1);return r}
function wkView(rows){
 var r=(rows||[]).map(function(x,i){return{x:wkSid(x),i:i}});
 if(WK_FILTERS.length||WK_TF.length)r=r.filter(function(o){return WK_FILTERS.indexOf(o.x.session)>=0||(!!o.x.topic&&WK_TF.indexOf(wkTk(o.x))>=0)});
 if(WK_SORT){var c=WK_SORT.col,sg=WK_SORT.dir==="desc"?-1:1;r.sort(function(a,b){var u=c==="session"?(a.x.session<b.x.session?-1:a.x.session>b.x.session?1:0):c==="time"?a.x.seconds-b.x.seconds:wkGroupOf(a.x)-wkGroupOf(b.x);return u?u*sg:a.i-b.i})}
 return r.map(function(o){return o.x});
}
var WK_LBL={"next":["run next","goes to the front of the waiting jobs and takes the next free slot"],"up":["move up","one place earlier in the waiting order"],"down":["move down","one place later in the waiting order"],"pause":["pause","stops taking model time, frees its slot for the next job, keeps its work"],"resume":["resume","goes back into the queue and continues"],"freeze":["freeze","stops its processes in memory (lost on reboot)"],"thaw":["thaw","continues the frozen processes"],"deep-freeze":["deep-freeze","saves its work and stops it; survives a reboot"],"deep-resume":["resume","continues from the saved stop"],"to-local":["move to local","restarts the job on the local model and continues its branch"],"to-cloud":["move to cloud","restarts the job on a cloud provider and continues its branch"],"stop":["stop","ends this command"]};
var WK_SURE={"deep-freeze":1,"to-local":1,"to-cloud":1},WK_CONF=null,WK_CT=null;
/** One-click inline confirm: the first click arms the button ("confirm?") for 3 s, the second runs it. True = run now. */
function wkArm(key,a,rd){if(!WK_SURE[a]||WK_CONF===key){WK_CONF=null;return true}WK_CONF=key;if(WK_CT)clearTimeout(WK_CT);WK_CT=setTimeout(function(){WK_CONF=null;rd()},3000);rd();return false}
/** The stable hue of a session name. */
function wkHue(n){var h=0,i;for(i=0;i<n.length;i++)h=(h*31+n.charCodeAt(i))%360;return h}
function wkChip(name,on){var h=wkHue(name);return'<button type="button" class="wq-chip'+(on?' on':'')+'" data-qs="'+esc(name)+'"'+(on?' aria-pressed="true"':'')+' style="--h:'+h+'" title="'+esc(name)+': click to show only this session (several may be active); click again to remove it">'+esc(name)+'</button>'}
/** The filter key of a topic chip: "session · topic" (a topic is only meaningful inside its session). */
function wkTk(r){return r.session+" · "+r.topic}
/** Topic chip: own muted hue per topic, max 16 chars, the full topic in the tooltip; click filters to that session's topic. */
function wkTopic(r,on){if(!r.topic)return"";var t=r.topic,s=t.length>16?t.slice(0,15)+"…":t;return' <button type="button" class="wq-chip wq-tp'+(on?' on':'')+'" data-qt="'+esc(wkTk(r))+'"'+(on?' aria-pressed="true"':'')+' style="--h:'+wkHue("topic:"+t)+'" title="'+esc("topic: "+t+" (click to show only "+wkTk(r)+")")+'">'+esc(s)+'</button>'}
/** One icon button of a row: data-qa = the action, data-id = the job; label in the tooltip and the aria-label. */
/** Model as a chip: each local provider its own stable hue, cloud: violet (sonnet), amber (opus), other cloud families their own. */
function wkModelHue(r){var m=r.model||"";if(r.local)return wkHue(m);return/opus/.test(m)?40:/sonnet/.test(m)?270:/haiku/.test(m)?200:/fable/.test(m)?320:290}
function wkModel(r){if(!r.model)return'<span class="dim">–</span>';return'<span class="wq-chip wq-mc" style="--h:'+wkModelHue(r)+'" title="'+esc(r.modelFull||r.model)+'">'+esc(r.model)+'</span>'}
var WK_ICO={"pause":"⏸","resume":"▶","stop":"■","next":"↑","deep-resume":"▶"};
function wkIconBtn(id,a){var l=WK_LBL[a]||[a,a],t=l[0]+": "+l[1];return'<button type="button" class="wq-ic" data-qa="'+a+'" data-id="'+esc(id)+'" title="'+esc(t)+'" aria-label="'+esc(l[0]+": "+l[1])+'">'+(WK_ICO[a]||l[0])+'</button>'}
function wkMenuBtn(key,tip){return'<button type="button" class="wq-ic'+(WK_MENU&&WK_MENU.key===key?' on':'')+'" data-wm="'+esc(key)+'" title="'+esc(tip)+'" aria-label="'+esc(tip)+'" aria-haspopup="true">⋯</button>'}
/** Copy the full worker id to the clipboard (the queue never shows it in full); a prompt fallback when the clipboard API is absent. */
function wkCopyId(id){var done=function(){WK_COPY=id;if(WK_CT)clearTimeout(WK_CT);WK_CT=setTimeout(function(){WK_COPY=null},1600)};try{if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(String(id)).then(done,function(){window.prompt("worker id (copy it)",String(id))});return}}catch(e){}window.prompt("worker id (copy it)",String(id))}
function wkTRow(r){
 var has=function(a){return r.actions.indexOf(a)>=0},main=has("deep-resume")?"deep-resume":has("resume")?"resume":"pause";
 var acts=(has(main)?wkIconBtn(r.id,main):"")+(has("next")?wkIconBtn(r.id,"next"):"")+wkMenuBtn("row:"+r.id,"more actions for "+r.task);
 var badge=r.state==="waiting"&&typeof r.slot==="number"?"waiting #"+r.slot:r.state;
 var st='<span class="wq-b '+(WK_BADGE[r.state]||"")+'" title="'+esc(r.stateText+(r.detail?" · "+r.detail:""))+'">'+esc(badge)+'</span>'+(r.activity&&r.state==="running"?' <span class="wq-act" title="'+esc(r.activityTip||r.now||"")+'">'+esc(r.activity)+'</span>':"");
 var tip=r.task;if(r.summary)tip+="\n\n"+r.summary;tip+="\nid: "+r.id;if(r.waits&&r.waits.length){for(var wi=0;wi<r.waits.length;wi++)tip+="\na session waits for this job: "+r.waits[wi].label}
 var task='<span class="wq-t" title="'+esc(tip)+'">'+esc(r.task)+'</span>'+(r.restarting?' <span class="wq-stale" title="the daemon restarts it on the new PAI version, keeping its place">restarting on new version</span>':"")+'<div class="wq-id" title="'+esc("worker id: "+r.id+" — ⋯ → copy id")+'">'+esc(r.sid||r.id)+'</div>';
 if(r.waits&&r.waits.length)task+='<span class="wq-eye" aria-label="a session waits for this job" title="'+esc(r.waits.map(function(w){return"a session waits for this job: "+w.label}).join("\n"))+'">◙</span>';
 var pr='<select class="wq-sel" data-qp="'+esc(r.id)+'" aria-label="priority" title="'+esc("priority: "+WK_PTIP[r.priority])+'">'+["low","normal","high","now"].map(function(l){return'<option value="'+l+'" title="'+esc(WK_PTIP[l])+'"'+(r.priority===l?" selected":"")+'>'+l+'</option>'}).join("")+'</select>';
 return'<tr class="wq-r" data-id="'+esc(r.id)+'"><td>'+st+'</td><td>'+wkChip(r.session,WK_FILTERS.indexOf(r.session)>=0)+wkTopic(r,WK_TF.indexOf(r.topic?wkTk(r):"")>=0)+'</td><td class="wq-tc">'+task+'</td><td class="wq-m">'+wkModel(r)+'</td><td>'+pr+'</td><td class="r">'+wkDur(r.seconds)+'</td><td class="wq-ac">'+acts+'</td></tr>';
}
function wkGroupOf(r){return r.state==="running"?0:r.state==="waiting"?1:2}
/** The one table: fixed layout, one line per job, a thin labelled separator where the group changes. */
function wkQTable(rows){
 var out='<table class="wq"><colgroup>'+WK_COLS.map(function(c){return'<col'+(c[2]?' style="width:'+c[2]+(typeof c[2]==="string"?"":"px")+'"':'')+'>'}).join("")+'</colgroup><thead><tr>'+WK_COLS.map(function(c){var k=c[0]==="time"?"time":c[0],sk=k==="state"||k==="session"||k==="time",on=WK_SORT&&WK_SORT.col===k,ar=on?(WK_SORT.dir==="desc"?" ▼":" ▲"):"";return'<th'+(c[1].indexOf(" r")>0?' class="r"':'')+(on?' aria-sort="'+(WK_SORT.dir==="desc"?"descending":"ascending")+'"':'')+'>'+(sk?'<button type="button" class="wq-sort'+(on?' on':'')+'" data-qsort="'+k+'" title="sort by '+k+' (click again: ascending, descending, default order)">'+c[0]+ar+'</button>':c[0])+'</th>'}).join("")+'</tr></thead><tbody>',g=-1;
 var bs=WK_SORT&&WK_SORT.col==="session",flat=WK_SORT&&!bs,sg=null;
 rows.forEach(function(r){if(bs){if(r.session!==sg){sg=r.session;out+='<tr class="wq-g"><td colspan="'+WK_COLS.length+'">'+esc(sg)+'</td></tr>'}}else if(!flat){var k=wkGroupOf(r);if(k!==g){g=k;out+='<tr class="wq-g"><td colspan="'+WK_COLS.length+'">'+WK_GROUPS[k]+'</td></tr>'}}out+=wkTRow(r)});
 return out+'</tbody></table>';
}
/** The open menu (row, session or All jobs), fixed at the clicked button. */
function wkMenuHtml(){
 if(!WK_MENU)return"";
 var k=WK_MENU.key,items=[],r;
 if(k==="all")items=[["data-qg","freeze","freeze all","stop every worker's processes in memory (lost on reboot)"],["data-qg","thaw","thaw all","continue all frozen processes"],["data-qg","deep-freeze",WK_CONF==="qg:deep-freeze"?"confirm?":"deep-freeze all","pai stop: save all work and stop everything; survives a reboot"],["data-qg","deep-resume","resume all","pai resume: restore everything saved"]];
 else if(k.indexOf("sess:")===0)items=[["pause","pause"],["freeze","freeze"],["deep-freeze","deep-freeze"],["deep-resume","resume saved"],["resume","resume"]].map(function(x){return["data-qx",x[0],(WK_CONF==="qx:"+x[0]?"confirm?":x[1]+" all of "+k.slice(5)),x[1]+" every job of this session: "+(WK_LBL[x[0]]||["",""])[1]]});
 else{r=((WQ&&WQ.table)||[]).filter(function(x){return"row:"+x.id===k})[0];if(!r)return"";
  items=["freeze","thaw","deep-freeze","deep-resume","to-cloud","to-local","up","down"].filter(function(a){return r.actions.indexOf(a)>=0}).map(function(a){var l=WK_LBL[a];return["data-qa",a,WK_CONF===r.id+":"+a?"confirm?":l[0],l[1],r.id]});
  items.push(["data-copy","copy",WK_COPY==="copy:"+r.id?"copied":"copy id","copy the full worker id to the clipboard: "+r.id,r.id])}
 return'<div class="wq-menu" role="menu" style="left:'+WK_MENU.x+'px;top:'+WK_MENU.y+'px">'+items.map(function(x){return'<button type="button" role="menuitem" '+x[0]+'="'+esc(x[1])+'"'+(x[4]?' data-id="'+esc(x[4])+'"':'')+' title="'+esc(x[3])+'">'+esc(x[2])+'</button>'}).join("")+'</div>';
}
/** Title row: (i) legend tooltip, the session chips as filters, and the All jobs menu at the right. */
function wkBar(q){
 var seen={},chips=(q.table||[]).filter(function(r){return!seen[r.session]&&(seen[r.session]=1)}).map(function(r){return wkChip(r.session,WK_FILTERS.indexOf(r.session)>=0)}).join(" ")+(function(){var ts={};return(q.table||[]).filter(function(r){return r.topic&&!ts[wkTk(r)]&&(ts[wkTk(r)]=1)}).map(function(r){return wkTopic(r,WK_TF.indexOf(wkTk(r))>=0)}).join("")})(),n=(q.table||[]).length,sh=(WK_FILTERS.length||WK_TF.length)?wkView(q.table).length:n,cnt=(WK_FILTERS.length||WK_TF.length)?'<span class="wq-cnt dim" title="active session filter">showing '+sh+' of '+n+'</span>':"";
 return'<div class="wq-bar"><span class="wq-i" tabindex="0" role="note" title="'+esc(WK_INFO+" "+WK_EXPLAIN+" "+WK_ACT)+'" aria-label="legend">(i)</span><span class="wq-chips">'+chips+'</span>'+cnt+'<button type="button" class="wq-all'+(WK_MENU&&WK_MENU.key==="all"?' on':'')+'" data-wm="all" aria-haspopup="true" title="actions on every job of the machine">All jobs ▾</button></div>';
}
var WK_NONE='<span class="dim">nothing running or waiting</span>';
var WQ=null,WK_BLOCKS={},WK_DRAG=null;
function wkDur(s){return s<90?s+"s":s<5400?Math.floor(s/60)+"m"+String(s%60).padStart(2,"0")+"s":Math.floor(s/3600)+"h"+String(Math.floor(s%3600/60)).padStart(2,"0")+"m"}
function wkSpanT(t,full){return' <span title="'+esc(full||t)+'">'+esc(t)+'</span>'}
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
 if((q.table||[]).length||!out.length)out.unshift({id:"queue",title:"worker queue — "+(q.table||[]).length+" job(s)",head:[],rows:[],table:true});
 return out;
}
function wkBlockOf(id){return WK_BLOCKS[id]||null}
/** A block's card html: the table (plus its footnote); a block that is gone says so. */
function wkBlockHtml(b){
 if(!b)return WK_NONE;
 if(b.table){var tr=wkView((WQ&&WQ.table)||[]);return wkBar(WQ||{})+'<div class="wq-w">'+wkQTable(tr)+'</div>'+wkMenuHtml()}
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
  var T=e.target&&e.target.closest?e.target:null,rd=function(){if(WQ)Win.update("queue",WQ)};
  var wm=T?T.closest("button[data-wm]"):null;
  if(wm){var k=wm.getAttribute("data-wm"),rc=wm.getBoundingClientRect();WK_MENU=WK_MENU&&WK_MENU.key===k?null:{key:k,x:Math.max(4,Math.min(Math.round(rc.left),window.innerWidth-190)),y:Math.round(rc.bottom)+2};rd();return}
  var inMenu=T&&T.closest(".wq-menu"),qs0=T?T.closest("button[data-qs]"):null;
  if(WK_MENU&&!inMenu&&!qs0){WK_MENU=null;rd()}
  var wc=T?T.closest("button[data-copy]"):null;
  if(wc){wkCopyId(wc.getAttribute("data-id"));WK_MENU=null;rd();return}
  var qa=T?T.closest("button[data-qa]"):null;
  if(qa){var qak=qa.getAttribute("data-qa");if(!qa.disabled&&wkArm(qa.getAttribute("data-id")+":"+qak,qak,rd)){WinA.runAction(ctx.id,"queue.act",{action:qa.getAttribute("data-qa"),id:qa.getAttribute("data-id")},qa,wkHost());if(inMenu){WK_MENU=null;rd()}}return}
  var qg=e.target&&e.target.closest?e.target.closest("button[data-qg]"):null;
  if(qg){var gv=qg.getAttribute("data-qg");if(!wkArm("qg:"+gv,gv,rd))return;WK_MENU=null;rd();if(gv.indexOf("deep")===0){WinA.runAction(ctx.id,"queue.act",{action:gv,all:true},qg,wkHost());return}(WQ&&WQ.table||[]).forEach(function(r){if(r.kind==="job"&&r.actions.indexOf(qg.getAttribute("data-qg"))>=0)WinA.runAction(ctx.id,"queue.act",{action:qg.getAttribute("data-qg"),id:r.id},qg,wkHost())});return}
  var so=T?T.closest("button[data-qsort]"):null;
  if(so){var sc=so.getAttribute("data-qsort");WK_SORT=!WK_SORT||WK_SORT.col!==sc?{col:sc,dir:"asc"}:WK_SORT.dir==="asc"?{col:sc,dir:"desc"}:null;wkSave();rd();return}
  var qt=T?T.closest("button[data-qt]"):null;
  if(qt){var tn=qt.getAttribute("data-qt"),ti=WK_TF.indexOf(tn);if(ti>=0)WK_TF.splice(ti,1);else WK_TF.push(tn);wkSave();rd();return}
  var qs=qs0;
  if(qs){var sn=qs.getAttribute("data-qs"),rc2=qs.getBoundingClientRect();var ix=WK_FILTERS.indexOf(sn);if(ix>=0)WK_FILTERS.splice(ix,1);else WK_FILTERS.push(sn);wkSave();WK_MENU=wkOne()?{key:"sess:"+wkOne(),x:Math.max(4,Math.min(Math.round(rc2.left),window.innerWidth-190)),y:Math.round(rc2.bottom)+2}:null;rd();return}
  var qx=e.target&&e.target.closest?e.target.closest("button[data-qx]"):null;
  if(qx){if(!qx.disabled&&wkArm("qx:"+qx.getAttribute("data-qx"),qx.getAttribute("data-qx"),rd))WinA.runAction(ctx.id,"queue.act",{action:qx.getAttribute("data-qx"),session:wkOne()},qx,wkHost());if(WK_CONF===null){WK_MENU=null;rd()}return}
  var cb=e.target&&e.target.closest?e.target.closest("button[data-wk]"):null;
  if(cb){wkCtlRun(ctx,"worker."+cb.getAttribute("data-wk"),cb.getAttribute("data-id"),undefined,cb);return}
  var pb=e.target&&e.target.closest?e.target.closest("button[data-wp]"):null;
  if(pb){if(pb.getAttribute("aria-pressed")!=="true")wkCtlRun(ctx,"worker.priority",pb.getAttribute("data-id"),pb.getAttribute("data-wp"),pb);return}
  var b=e.target&&e.target.closest?e.target.closest("button[data-q]"):null;
  if(!b)return;
  var v=b.getAttribute("data-q");
  wkRun(ctx,v,{id:b.getAttribute("data-id")},b,v==="next"?"moved to next":"moved up one place");
 });
 body.addEventListener("change",function(e){
  var sel=e.target&&e.target.closest?e.target.closest("select[data-qp]"):null;
  if(sel)WinA.runAction(ctx.id,"queue.act",{action:"prio-"+sel.value,id:sel.getAttribute("data-qp")},sel,wkHost());
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
 if(ctx.id==="workers.queue"&&document.activeElement&&document.activeElement.className==="wq-sel"&&ctx.body.contains(document.activeElement))return null;
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
