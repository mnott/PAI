/** cockpit-page/win — `workers`: the queue section on the win runtime.
 *  Page-scope ES5 (after scriptCore: esc/table in scope), needs `Win`, `WinT`, `WinA` and `loadQueue`. Feed `queue`
 *  (/cockpit/queue). Group `workers`: the `note` cards `workers.local` / `workers.wt` (local-model and worktrees lines) and one
 *  dynamic `table` card per block, added by data through Win.addCards: `workers.plans|panes|violations|tests|builds`,
 *  `workers.prov:<provider>` (a serialising provider) and `workers.sess:<session>`. `next`/`up` are row buttons that run
 *  the registered queue.next / queue.up actions (/cockpit/queue/<verb>); the result is the table card's status. Waiting
 *  rows of a serialising provider drag-reorder as a row-level HTML5 drag inside their card (queue.move); while a row
 *  drag is active in a card that card is not repainted (WK_DRAG, the card.busyDrag of the spec). The `table`/`note` types
 *  are the generic types of win/types.ts; the cards here only carry views (wkTableView / wkLocalView / wkWtView). */

export const WIN_WORKERS_JS = String.raw`var WK_INFO="One table for the whole machine: running jobs first, then the waiting ones in the order they will be admitted, then the paused and frozen ones. Every button acts on that one job (or on every job of a session) and the state badge shows the effect at once. ▶ one step toward running · ⏸ one step toward paused · stop and more in …";
var WK_EXPLAIN="running = holds a slot, or started and waiting to take its slot back; waiting = next in line; paused = parked, its slot is free for the next job; frozen = stopped in memory, lost on reboot; deep-frozen = stopped and saved, survives a reboot. Priority: low = others go first; normal = default; high = ahead of normal; now = front of the queue, pauses all other local jobs while it runs. Slots: N of M slots busy counts jobs holding a slot; K waiting for their slot back = started jobs that hold a ticket to get a slot back (their own rows); engine idle: admitted K extra = jobs started above the cap because the model had nothing to do.";
var WK_ACT="Activity: writing = its request is open at the model, the model is writing its reply; in line = waiting for the model, either at the engine or for a slot (the tooltip says which); tool = no request open, a tool (build, test) is running; waiting = waiting for a slot, no request has gone to the model yet; idle Nm = no request at the model and no tool running for N minutes, it may be stuck.";
var WK_BTNS="Buttons: ▶ one step toward running (paused → resume to the front of the line, waiting → start now over the cap up to the ceiling), ⏸ one step toward paused (running / waiting → pause, its work kept), ⋯ more actions (stop, back to queue, freeze, move, priority). Chips: the coloured session chip filters to that session, the dashed topic chip filters to that topic, the model chip names the model (↑ = why it is not local).";
var WK_COLS=[["state","state",150],["session","session",130],["task","task","40%"],["model","model",110],["prio","prio",90],["time","time r",80],["actions","actions",210]];
var WK_PTIP={low:"others go first",normal:"default",high:"ahead of normal","now":"front of the queue and pauses all other local jobs while it runs"};
var WK_GROUPS=["running","waiting","paused"];
var WK_BADGE={"running":"wq-run","waiting":"wq-wait","paused":"wq-pause","frozen":"wq-frozen","deep-frozen":"wq-deep"};
var WK_FILTERS=[],WK_TF=[],WK_SORT=null,WK_MENU=null,WK_COPY=null;
/** Filters (session names), sort ({col,dir}) and the rows whose inline detail is open persist in localStorage. */
function wkLoad(){try{var f=JSON.parse(localStorage.getItem("wqFilter")||"[]"),s=JSON.parse(localStorage.getItem("wqSort")||"null");if(Array.isArray(f))WK_FILTERS=f.filter(function(x){return typeof x==="string"});var tf=JSON.parse(localStorage.getItem("wqTopic")||"[]");if(Array.isArray(tf))WK_TF=tf.filter(function(x){return typeof x==="string"});if(s&&(s.col==="session"||s.col==="state"||s.col==="time"))WK_SORT={col:s.col,dir:s.dir==="desc"?"desc":"asc"};var o=JSON.parse(localStorage.getItem("wqOpen")||"{}");if(o&&typeof o==="object")for(var k in o)if(typeof k==="string")WK_OPEN[k]=1}catch(e){}}
function wkSave(){try{localStorage.setItem("wqFilter",JSON.stringify(WK_FILTERS));localStorage.setItem("wqTopic",JSON.stringify(WK_TF));if(WK_SORT)localStorage.setItem("wqSort",JSON.stringify(WK_SORT));else localStorage.removeItem("wqSort");localStorage.setItem("wqOpen",JSON.stringify(WK_OPEN))}catch(e){}}
wkLoad();
/** The one open session (for the session menu): the single active filter, else null. */
function wkOne(){return WK_FILTERS.length===1?WK_FILTERS[0]:null}
/** Filtered by the chosen sessions, then sorted (admission order is the tie-break and the default). */
/** The short id (last dash-part) in grey under the task; computed here so every view has it.
 *  WK_OPEN: the ids of the rows whose inline detail is open (a tap on a row or its ▸ opens it, a tap again closes). */
var WK_OPEN={};
/** Narrow mode (the html.narrow class, the 900 px break): the detail is its own full-width table row under the job row (the task cell is too narrow on a phone) and shows only there; in wide mode it is never drawn (the columns carry everything). */
function wkNarrow(){return typeof document!=="undefined"&&!!document.documentElement&&document.documentElement.classList.contains("narrow")}
function wkSid(r){r.sid=String(r.id).slice(String(r.id).lastIndexOf("-")+1);return r}
/** "12m left" / "3m over" from the deadline (seconds to the stop; negative = past it); "" without one. */
function wkLeft(s){if(typeof s!=="number"||!isFinite(s))return"";var x=Math.round(s);return wkDur(x)+(x<0?" over":" left")}
/** The narrow second line's runtime: "12m · own 8m · 32m left" (age, the job's own time, budget left; parts absent when unknown). */
function wkRuntime(r){var p=[wkDur(r.seconds)];if(typeof r.activeSeconds==="number")p.push("own "+wkDur(r.activeSeconds));if(typeof r.budgetLeftMin==="number"){var m=Math.abs(Math.round(r.budgetLeftMin));p.push((m<60?m+"m":wkDur(m*60))+(r.budgetLeftMin<0?" over":" left"))}return p.join(" · ")}
function wkView(rows){return wkSort(wkPass(rows))}
/** Filtered rows in admission order (no sort): the group headers count over these. */
function wkPass(rows){
 wkAssign((rows||[]).map(function(x){return x.session}));
 var r=(rows||[]).map(function(x,i){return{x:wkSid(x),i:i}});
 if(WK_FILTERS.length||WK_TF.length)r=r.filter(function(o){return WK_FILTERS.indexOf(o.x.session)>=0||(!!o.x.topic&&WK_TF.indexOf(wkTk(o.x))>=0)});
 return r.map(function(o){return o.x});
}
/** Filtered by the chosen sessions, then sorted (admission order is the tie-break and the default). */
function wkSort(rows){
 var r=(rows||[]).map(function(x,i){return{x:x,i:i}});
 if(WK_SORT){var c=WK_SORT.col,sg=WK_SORT.dir==="desc"?-1:1;r.sort(function(a,b){var u=c==="session"?(a.x.session<b.x.session?-1:a.x.session>b.x.session?1:0):c==="time"?a.x.seconds-b.x.seconds:wkGroupOf(a.x)-wkGroupOf(b.x);return u?u*sg:a.i-b.i})}
 return r.map(function(o){return o.x});
}
var WK_LBL={"next":["run next","goes to the front of the waiting jobs and takes the next free slot"],"up":["move up","one place earlier in the waiting order"],"down":["move down","one place later in the waiting order"],"pause":["pause","stops taking model time, frees its slot for the next job, keeps its work"],"resume":["resume","goes back into the queue at the front of the line and continues"],"back-to-queue":["back to queue","stops taking model time, frees its slot, waits first in line, keeps its work"],"start-now":["start now","runs now even if all slots are busy (over the cap, up to the hard ceiling)"],"freeze":["freeze","stops its processes in memory (lost on reboot)"],"thaw":["thaw","continues the frozen processes"],"deep-freeze":["deep-freeze","saves its work and stops it; survives a reboot"],"deep-resume":["resume","continues from the saved stop"],"to-local":["move to local","restarts the job on the local model and continues its branch"],"to-cloud":["move to cloud","restarts the job on a cloud provider and continues its branch"],"stop":["stop","ends this command for good; its work stays on its branch"]};
var WK_SURE={"deep-freeze":1,"to-local":1,"to-cloud":1,"stop":1},WK_CONF=null,WK_CT=null;
/** One-click inline confirm: the first click arms the button ("confirm?") for 3 s, the second runs it. True = run now. */
function wkArm(key,a,rd){if(!(WK_SURE[a]||(a==="pause"&&wkNarrow()))||WK_CONF===key){WK_CONF=null;return true}WK_CONF=key;if(WK_CT)clearTimeout(WK_CT);WK_CT=setTimeout(function(){WK_CONF=null;rd()},3000);rd();return false}
/** 12 clearly distinct hues (readable on the dark background). A name takes the hue of its stable hash; sessions visible together never share one (wkAssign). */
var WK_PAL=[5,28,48,85,140,170,190,210,240,270,300,330],WK_SH={};
function wkHash(n){var h=0,i;for(i=0;i<n.length;i++)h=(h*31+n.charCodeAt(i))%9973;return h}
function wkHue(n){return WK_PAL[wkHash(n)%WK_PAL.length]}
/** Collision check: the hash slot of each visible session, the next free slot when taken (names in sorted order, so it is stable). */
function wkAssign(names){var used={},out={},u=names.filter(function(x,i){return names.indexOf(x)===i}).sort(),i,k,n;for(i=0;i<u.length;i++){k=wkHash(u[i])%WK_PAL.length;for(n=0;n<WK_PAL.length&&used[k];n++)k=(k+1)%WK_PAL.length;used[k]=1;out[u[i]]=WK_PAL[k]}WK_SH=out}
function wkSessHue(n){return WK_SH[n]!==undefined?WK_SH[n]:wkHue(n)}
function wkChip(name,on){var h=wkSessHue(name);return'<button type="button" class="wq-chip'+(on?' on':'')+'" data-qs="'+esc(name)+'"'+(on?' aria-pressed="true"':'')+' style="--h:'+h+'" title="'+esc(name)+': click to show only this session (several may be active); click again to remove it">'+esc(name)+'</button>'}
/** The filter key of a topic chip: "session · topic" (a topic is only meaningful inside its session). */
function wkTk(r){return r.session+" · "+r.topic}
/** Topic chip: own muted hue per topic, max 16 chars, the full topic in the tooltip; click filters to that session's topic. */
function wkTopic(r,on){if(!r.topic)return"";var t=r.topic,s=t.length>16?t.slice(0,15)+"…":t;return' <button type="button" class="wq-chip wq-tp'+(on?' on':'')+'" data-qt="'+esc(wkTk(r))+'"'+(on?' aria-pressed="true"':'')+' style="--h:'+wkHue("topic:"+t)+'" title="'+esc("topic: "+t+" (click to show only "+wkTk(r)+")")+'">'+esc(s)+'</button>'}
/** One icon button of a row: data-qa = the action, data-id = the job; label in the tooltip and the aria-label. */
/** Model as a chip: each local provider its own stable hue, cloud: violet (sonnet), amber (opus), other cloud families their own. */
function wkModelHue(r){var m=r.model||"";if(r.local)return wkHue(m);return/opus/.test(m)?40:/sonnet/.test(m)?270:/haiku/.test(m)?200:/fable/.test(m)?320:290}
/** A cloud job carries "↑" on its model chip and says why it is not local in the tooltip (cloudWhy: route / reroute / escalation fields). */
function wkModel(r){if(!r.model)return'<span class="dim">–</span>';var up=!r.local&&r.cloudWhy;return'<span class="wq-chip wq-mc" style="--h:'+wkModelHue(r)+'" title="'+esc((up?r.cloudWhy+"\n":"")+(r.modelFull||r.model)+(r.instance&&r.instance!==r.model?" · instance "+r.instance:""))+'">'+(up?'↑ ':'')+esc(r.model)+'</span>'}
var WK_LTIP={0:"L0 the session that owns these jobs",1:"L1 coordinates: splits the work, starts L2 workers, checks their results",2:"L2 does the work"};
/** The level badge before the task text. depth = how far this row hangs below its ancestor (1 = "└" one indent, 2 = two); the tree is built per session inside each state group. */
function wkLevel(r,kid,depth){var d=depth||0,p="";for(var i=0;i<d;i++)p+='<span class="wq-kid" aria-hidden="true">└</span>';var lv=r.level===1?1:2;return p+'<span class="wq-lv wq-l'+lv+'" title="'+esc(WK_LTIP[lv])+'">L'+lv+'</span>'}
var WK_ICO={"pause":"⏸","resume":"▶","start-now":"▶","back-to-queue":"⤒","stop":"■","next":"⤒","up":"↑","down":"↓","deep-resume":"▶"};
/** One icon button of a row: data-qa = the action, data-id = the job; label in the tooltip and the aria-label. A disabled one says why (disabled buttons carry no tooltip: the reason rides in the aria-label). */
function wkIconBtn(id,a,why){var l=WK_LBL[a]||[a,a],t=l[0]+": "+l[1];return'<button type="button" class="wq-ic'+(a==="up"||a==="down"?" wq-sm":"")+'" data-qa="'+a+'" data-id="'+esc(id)+'"'+(why?' disabled aria-disabled="true"':'')+' title="'+esc(why?l[0]+" — "+why:t)+'" aria-label="'+esc(why?l[0]+": "+why:l[0]+": "+l[1])+'">'+(WK_ICO[a]||l[0])+'</button>'}
function wkMenuBtn(key,tip){return'<button type="button" class="wq-ic'+(WK_MENU&&WK_MENU.key===key?' on':'')+'" data-wm="'+esc(key)+'" title="'+esc(tip)+'" aria-label="'+esc(tip)+'" aria-haspopup="true">⋯</button>'}
/** Copy the full worker id to the clipboard (the queue never shows it in full); a prompt fallback when the clipboard API is absent. */
function wkCopyId(id){var done=function(){WK_COPY=id;if(WK_CT)clearTimeout(WK_CT);WK_CT=setTimeout(function(){WK_COPY=null},1600)};try{if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(String(id)).then(done,function(){window.prompt("worker id (copy it)",String(id))});return}}catch(e){}window.prompt("worker id (copy it)",String(id))}
/** The inline detail block of an open row (narrow mode shows it; wide mode hides it by CSS): what the job is doing now, its TL;DR, route and time left. */
function wkDetail(r){
 var x='<div class="wq-x" data-x="'+esc(r.id)+'">';
 // compact panel directly under the row: task, TL;DR, id, engine/provider, age / own time / budget left, turns and tools, "now:", last error, queue position
 x+='<button type="button" class="wq-xc" data-wqx="'+esc(r.id)+'" aria-label="close detail" title="close">✕</button><div class="wq-dt">'+wkLevel(r,false)+esc(r.task)+'</div>';
 if(r.summary)x+='<div class="dim wq-sum">'+esc(r.summary)+'</div>';
 x+='<div class="dim wq-id2" title="'+esc("tap the row again to copy the full worker id")+'">worker: '+esc(r.sid||r.id)+'</div>';
 var meta=[],eng=r.modelFull?r.modelFull+(r.cloudWhy?" ("+r.cloudWhy+")":""):r.model;
 if(eng)meta.push("engine: "+esc(eng));
 if(r.instance)meta.push("instance: "+esc(r.instance));
 meta.push("priority: "+esc(r.priority));
 var t="age: "+wkDur(r.seconds);
 if(typeof r.activeSeconds==="number")t+=" · own: "+wkDur(r.activeSeconds);
 if(typeof r.budgetLeftMin==="number"){var m=Math.abs(Math.round(r.budgetLeftMin));t+=" · budget left: "+(m<60?m+"m":wkDur(m*60))+(r.budgetLeftMin<0?" over":"")}else if(r.deadlineAt)t+=" · "+esc(wkLeft((r.deadlineAt-Date.now())/1000));
 meta.push(t);
 meta.push("turns: "+(r.turns||0)+" · tools: "+(r.tools||0));
 if(typeof r.slot==="number")meta.push("queue position: "+r.slot);
 x+='<div class="dim wq-meta">'+meta.join("<br>")+'</div>';
 if(r.activity||r.now)x+='<div class="wq-nowline"><b>now:</b>'+(r.now?' <span class="wq-now" title="'+esc(r.activityTip||r.now)+'">'+esc(r.now)+'</span>':" "+esc(r.activity))+'</div>';
 if(r.lastError)x+='<div class="wq-err">last error: '+esc(r.lastError)+'</div>';else if(r.specTip)x+='<div class="wq-err">guard: '+esc(r.specTip)+'</div>';
 if(r.waits&&r.waits.length)r.waits.forEach(function(w){x+='<div class="dim">a session waits: '+esc(w.label)+'</div>'});
 x+=wkDtActs(r);
 x+='</div>';
 return x;
}
/** Phone detail only: the row actions live here, spaced apart; pause and stop need a second tap (inline "tap again to confirm"). */
function wkDtBtn(r,a,label,why){var k=r.id+":"+a,arm=WK_CONF===k;return'<button type="button" class="wq-db'+(arm?' arm':'')+'" data-qa="'+a+'" data-id="'+esc(r.id)+'"'+(why?' disabled aria-disabled="true"':'')+' title="'+esc(why||(WK_LBL[a]||[a,a])[1])+'">'+(arm?'tap again to confirm':esc(label))+'</button>'}
function wkDtActs(r){
 var has=function(a){return r.actions.indexOf(a)>=0},b="";
 if(r.state==="running")b=wkDtBtn(r,"pause","pause");
 else if(r.state==="waiting")b=wkDtBtn(r,"start-now","start now",has("start-now")?"":(r.startNowWhy||"the limit of started jobs is reached"))+wkDtBtn(r,"pause","pause");
 else b=has("deep-resume")?wkDtBtn(r,"deep-resume","resume"):wkDtBtn(r,"resume","resume",has("resume")?"":"this job cannot resume right now");
 if(has("stop"))b+=wkDtBtn(r,"stop","stop");
 var pr='<select class="wq-sel wq-dsel" data-qp="'+esc(r.id)+'" aria-label="priority">'+["low","normal","high","now"].map(function(l){return'<option value="'+l+'"'+(r.priority===l?" selected":"")+'>'+l+'</option>'}).join("")+'</select>';
 return'<div class="wq-da">'+b+pr+wkMenuBtn("row:"+r.id,"more actions for "+r.task)+'</div>';
}
function wkTRow(r){
 var has=function(a){return r.actions.indexOf(a)>=0};
 // the inline buttons carry one meaning each: ▶ one step toward running (paused → resume, waiting → start now), ⏸ one step toward paused (running / waiting → pause); stop and everything else in …
 var acts;
 if(r.state==="running")acts=wkIconBtn(r.id,"pause")+wkMenuBtn("row:"+r.id,"more actions for "+r.task);
 else if(r.state==="waiting")acts=(has("start-now")?wkIconBtn(r.id,"start-now",r.startNowWhy):wkIconBtn(r.id,"start-now",r.startNowWhy||"the limit of started jobs is reached"))+wkIconBtn(r.id,"pause")+wkMenuBtn("row:"+r.id,"more actions for "+r.task);
 else acts=(has("deep-resume")?wkIconBtn(r.id,"deep-resume"):has("resume")?wkIconBtn(r.id,"resume"):wkIconBtn(r.id,"resume","this job cannot resume right now"))+wkMenuBtn("row:"+r.id,"more actions for "+r.task);
 var badge=r.state==="waiting"&&typeof r.slot==="number"?"waiting #"+r.slot:r.state;
 var st='<span class="wq-b '+(WK_BADGE[r.state]||"")+'" title="'+esc(r.stateText+(r.detail?" · "+r.detail:""))+'">'+esc(badge)+'</span>'+(r.activity&&r.state==="running"?' <span class="wq-act" title="'+esc(r.activityTip||r.now||"")+'">'+esc(r.activity)+'</span>':"");
 var tip=r.task+(r.sid?" · "+r.sid:"");if(r.summary)tip+="\n\n"+r.summary;tip+="\nid: "+r.id;if(r.waits&&r.waits.length){for(var wi=0;wi<r.waits.length;wi++)tip+="\na session waits for this job: "+r.waits[wi].label}
 tip+="\n\nmodel: "+(r.modelFull||r.model||"-")+(r.cloudWhy?" ("+r.cloudWhy+")":"")+"\npriority: "+r.priority+"\ntime: "+wkDur(r.seconds);
 var op=!!WK_OPEN[r.id];
 // the narrow second line (always there): the task ellipsised to one line, then the runtime "12m · own 8m · 32m left" and the short id
 var task='<button type="button" class="wq-cx" data-wqx="'+esc(r.id)+'" aria-expanded="'+(op?"true":"false")+'" title="'+esc("what this job is doing now")+'" aria-label="'+esc((op?"collapse ":"expand ")+r.task+' — what it is doing now')+'">'+(op?"▾":"▸")+'</button>'+wkLevel(r,false,typeof r.depth==="number"?r.depth:(r.level!==1&&!!r.parent&&((WQ&&WQ.table)||[]).some(function(x){return x.id===r.parent&&x.level===1})?1:0))+'<div class="wq-nl"><span class="wq-t" title="'+esc(tip)+'">'+esc(r.task)+(r.parentHint?' <span class="dim wq-phint">under '+esc(r.parentHint)+'</span>':"")+'</span><div class="wq-id" title="'+esc("worker id: "+r.id+" — ⋯ → copy id")+'">'+esc(wkRuntime(r))+" · "+esc(r.sid||r.id)+(r.instance?" · "+esc(r.instance):"")+'</div></div>'+(r.restarting?' <span class="wq-stale" title="the daemon restarts it on the new PAI version, keeping its place">restarting on new version</span>':"")+(r.specTip?' <span class="wq-q" tabindex="0" role="note" title="'+esc(r.specTip)+'" aria-label="'+esc(r.specTip)+'">?</span>':"");
 // the tap detail: a compact panel directly below the row's first line (narrow mode only; wide mode hides it by CSS — the columns carry everything there)
 var dtl=op&&wkNarrow()?'<tr class="wq-xr" data-xr="'+esc(r.id)+'"><td colspan="'+WK_COLS.length+'">'+wkDetail(r).replace('class="wq-x"','class="wq-x on"')+'</td></tr>':"";
 if(r.waits&&r.waits.length)task+='<span class="wq-eye" aria-label="a session waits for this job" title="'+esc(r.waits.map(function(w){return"a session waits for this job: "+w.label}).join("\n"))+'">◙</span>';
 var pr='<select class="wq-sel" data-qp="'+esc(r.id)+'" aria-label="priority" title="'+esc("priority: "+WK_PTIP[r.priority])+'">'+["low","normal","high","now"].map(function(l){return'<option value="'+l+'" title="'+esc(WK_PTIP[l])+'"'+(r.priority===l?" selected":"")+'>'+l+'</option>'}).join("")+'</select>';
 return'<tr class="wq-r" data-id="'+esc(r.id)+'"><td>'+st+'</td><td>'+wkChip(r.session,WK_FILTERS.indexOf(r.session)>=0)+wkTopic(r,WK_TF.indexOf(r.topic?wkTk(r):"")>=0)+'</td><td class="wq-tc">'+task+'</td><td class="wq-m">'+wkModel(r)+'</td><td class="wq-p">'+pr+'</td><td class="r wq-tm">'+wkDur(r.seconds)+'</td><td class="wq-ac">'+acts+'</td></tr>'+dtl;
}
/** Interactive local sessions: state (generating / idle Nm) + failover badge, session chip, engine, last request age, tokens served; the second line (narrow pattern) carries tokens and request age. */
function wkTok(n){n=n||0;return n<1000?String(n):n<1e6?(n/1000).toFixed(1)+"k":(n/1e6).toFixed(1)+"M"}
function wkSessRow(s){
 var st=s.inflight?"generating":"idle "+Math.floor(s.lastAgeSec/60)+"m",fo=s.failover?' <span class="wq-b" title="failed over from the cloud to the local model (ROUTER-FAILOVER)">failover</span>':"";
 var sub=wkTok(s.tokens)+" tokens · last request "+wkDur(s.lastAgeSec)+" ago";
 return'<tr class="wq-r wq-sess" data-sess="'+esc(s.session)+'"><td><span class="wq-b '+(s.inflight?"wq-run":"")+'">'+esc(st)+'</span>'+fo+'</td><td>'+wkChip(s.session,WK_FILTERS.indexOf(s.session)>=0)+'</td><td class="wq-tc"><div class="wq-nl"><span class="wq-t" title="'+esc(s.requests+" request(s)")+'">'+esc(s.session)+' · '+esc(s.engine)+'</span><div class="wq-id">'+esc(sub)+'</div></div></td><td class="wq-m">'+esc(s.engine)+'</td><td class="wq-p"></td><td class="r wq-tm">'+wkDur(s.lastAgeSec)+'</td><td class="wq-ac">'+esc(wkTok(s.tokens))+'</td></tr>';
}
function wkSessHtml(ss){
 if(!ss||!ss.length)return"";
 var out='<tr class="wq-g"><td colspan="'+WK_COLS.length+'">Sessions (interactive)</td></tr>';
 ss.forEach(function(s){out+=wkSessRow(s)});
 return out;
}
/** L0 of the worker tree: the owning session's own row — its badge, its chip, and its jobs' count/summary in the task column. No actions: a job is acted on by its own row. */
function wkL0Row(name,n){var run=0,wt=0;((WQ&&WQ.table)||[]).forEach(function(x){if(x.session===name){if(x.state==="running")run++;else if(x.state==="waiting")wt++}});var sum=run+" running · "+wt+" waiting";return'<tr class="wq-r wq-l0" data-sess="'+esc(name)+'"><td><span class="wq-lv wq-l0b" title="'+esc(WK_LTIP[0])+'">L0</span></td><td>'+wkChip(name,WK_FILTERS.indexOf(name)>=0)+'</td><td class="wq-tc"><div class="wq-nl"><span class="wq-t">'+esc(n)+' job'+(n===1?'':'s')+'</span><div class="wq-id">'+esc(sum)+'</div></div></td><td class="wq-m"></td><td class="wq-p"></td><td class="r wq-tm"></td><td class="wq-ac"></td></tr>'}
/** The tree of one state group: per session (first appearance order) an L0 row, then its jobs hanging under it —
 *  an L1 at depth 1 ("└"), an L2 under its own L1 at depth 2 ("└ └"), an L2 without a live L1 parent directly under L0
 *  (depth 1) with the parent's short label as a hint. A child whose parent sits in another group still hangs under
 *  its own session's L0 here. Jobs of no session keep their place, flat. */
function wkTree(rows){
 var all=(WQ&&WQ.table)||[],byId={},i;
 for(i=0;i<all.length;i++)byId[all[i].id]=all[i];
 var out=[],groups=[[],[],[]],sess={};
 for(i=0;i<rows.length;i++){var r=rows[i];if(!r.session||r.session==="other"){out.push({x:r,depth:0});continue}groups[wkGroupOf(r)].push(r)}
 for(var g=0;g<3;g++){
  var gr=groups[g],order=[],idx={};
  for(i=0;i<gr.length;i++){var s=gr[i].session;if(idx[s]===undefined){idx[s]=order.length;order.push(s);sess[s]={}}sess[s][gr[i].id]=1}
  order.forEach(function(name){
   out.push({l0:name,first:gr[gr.findIndex(function(x){return x.session===name})],n:gr.filter(function(x){return x.session===name}).length});
   var l1s=gr.filter(function(x){return x.session===name&&x.level===1}),kids={};
   for(i=0;i<l1s.length;i++){var p=l1s[i];out.push({x:p,depth:1});(kids[p.id]=kids[p.id]||[]).push(p)}
   gr.forEach(function(r){if(r.session!==name||r.level===1)return;
    var par=r.parent?byId[r.parent]:null,hang=par&&par.level===1&&sess[name][par.id];
    if(hang){out.push({x:r,depth:2})}
    else{var hint=par&&par.session===name?String(par.task||"").slice(0,40):"";out.push({x:r,depth:1,parentHint:hint})}});
  });
 }
 return out;
}
/** Rows of one state group clustered by owning session (first appearance order, stable); jobs without a session stay where they are. */
function wkByOwner(rows){var out=[],seen={},i,j;for(i=0;i<rows.length;i++){var r=rows[i],k=wkGroupOf(r);if(!r.session||r.session==="other"){out.push(r);continue}var key=k+"|"+r.session;if(seen[key])continue;seen[key]=1;for(j=i;j<rows.length;j++)if(wkGroupOf(rows[j])===k&&rows[j].session===r.session)out.push(rows[j])}return out}
function wkGroupOf(r){return r.state==="running"?0:r.state==="waiting"?1:2}
/** The one table: fixed layout, one line per job. A group's label appears ONCE, above its rows — never after a row and never more than once per group (an empty group still shows "(none)"). */
function wkQTable(rows){
 var g0=wkGroupOf,out='<table class="wq"><colgroup>'+WK_COLS.map(function(c){return'<col'+(c[2]?' style="width:'+c[2]+(typeof c[2]==="string"?"":"px")+'"':'')+'>'}).join("")+'</colgroup><thead><tr>'+WK_COLS.map(function(c){var k=c[0]==="time"?"time":c[0],sk=k==="state"||k==="session"||k==="time",on=WK_SORT&&WK_SORT.col===k,ar=on?(WK_SORT.dir==="desc"?" ▼":" ▲"):"";return'<th'+(c[1].indexOf(" r")>0?' class="r"':'')+(on?' aria-sort="'+(WK_SORT.dir==="desc"?"descending":"ascending")+'"':'')+'>'+(sk?'<button type="button" class="wq-sort'+(on?' on':'')+'" data-qsort="'+k+'" title="sort by '+k+' (click again: ascending, descending, default order)">'+c[0]+ar+'</button>':c[0])+'</th>'}).join("")+'</tr></thead><tbody>'+wkSessHtml(WQ&&WQ.sessions);
 var bs=WK_SORT&&WK_SORT.col==="session",flat=WK_SORT&&!bs;
 if(flat){rows.forEach(function(r){out+=wkTRow(r)})}
 else{
  // one header per group, above its rows: a group with no rows reads "(none)" and keeps its place (a filtered-out group is still named)
  var vis=[0,0,0];rows.forEach(function(r){vis[g0(r)]++});
  if(bs){var sg=null;rows.forEach(function(r){if(r.session!==sg){sg=r.session;out+='<tr class="wq-g"><td colspan="'+WK_COLS.length+'">'+esc(sg)+'</td></tr>'}out+=wkTRow(r)})}
  // the group's own position, not a shared loop counter: the header is emitted exactly once per group, before its first row; inside it the tree hangs L1/L2 under the session's L0
  else{var last=-1,nxt=wkTree(rows);nxt.forEach(function(o){var k=o.l0?wkGroupOf(o.first):g0(o.x);if(k!==last){last=k;out+='<tr class="wq-g"><td colspan="'+WK_COLS.length+'">'+WK_GROUPS[k]+(vis[k]?'':' <span class="dim">(none)</span>')+'</td></tr>'}if(o.l0){out+=wkL0Row(o.l0,o.n);return}var r=o.x;r.depth=o.depth;r.parentHint=o.parentHint||"";out+=wkTRow(r)});[0,1,2].forEach(function(k){if(!vis[k])out+='<tr class="wq-g"><td colspan="'+WK_COLS.length+'">'+WK_GROUPS[k]+' <span class="dim">(none)</span></td></tr>'})}
 }
 return out+'</tbody></table>';
}
/** The open menu (row, session or All jobs), fixed at the clicked button. */
function wkMenuHtml(){
 if(!WK_MENU)return"";
 var k=WK_MENU.key,items=[],r;
 if(k==="all")items=[["data-qg","freeze","freeze all","stop every worker's processes in memory (lost on reboot)"],["data-qg","thaw","thaw all","continue all frozen processes"],["data-qg","deep-freeze",WK_CONF==="qg:deep-freeze"?"confirm?":"deep-freeze all","pai stop: save all work and stop everything; survives a reboot"],["data-qg","deep-resume","resume all","pai resume: restore everything saved"]];
 else if(k.indexOf("sess:")===0)items=[["pause","pause"],["freeze","freeze"],["deep-freeze","deep-freeze"],["deep-resume","resume saved"],["resume","resume"]].map(function(x){return["data-qx",x[0],(WK_CONF==="qx:"+x[0]?"confirm?":x[1]+" all of "+k.slice(5)),x[1]+" every job of this session: "+(WK_LBL[x[0]]||["",""])[1]]});
 else{r=((WQ&&WQ.table)||[]).filter(function(x){return"row:"+x.id===k})[0];if(!r)return"";
  items=["back-to-queue","next","up","down","freeze","thaw","deep-freeze","deep-resume","to-cloud","to-local"].filter(function(a){return r.actions.indexOf(a)>=0}).map(function(a){var l=WK_LBL[a],rr=a==="to-cloud"||a==="to-local";return["data-qa",a,WK_CONF===r.id+":"+a?"confirm?":rr?(a==="to-cloud"?"Run on cloud":"Run locally"):l[0],rr?"now on "+(r.local?"local":"cloud")+": "+l[1]:l[1],r.id]});
  if(r.kind==="job")items.push(["data-qa","stop",WK_CONF===r.id+":stop"?"confirm?":"stop","ends this job for good (click again to confirm); its work stays on its branch",r.id]);
  items.push(["data-copy","copy",WK_COPY==="copy:"+r.id?"copied":"copy id","copy the full worker id to the clipboard: "+r.id,r.id]);
  items.push(["data-wqx","detail",(WK_OPEN[r.id]?"collapse":"show")+" detail","what this job is doing now, its TL;DR, route and time left",r.id])}
 return'<div class="wq-menu" role="menu" style="left:'+WK_MENU.x+'px;top:'+WK_MENU.y+'px">'+items.map(function(x){return'<button type="button" role="menuitem" '+x[0]+'="'+esc(x[1])+'"'+(x[4]?' data-id="'+esc(x[4])+'"':'')+' title="'+esc(x[3])+'">'+esc(x[2])+'</button>'}).join("")+'</div>';
}
/** Title row: (i) legend tooltip, the session chips as filters, and the All jobs menu at the right. */
/** The short (i) legend: pills, levels, state badges; a handful of lines, not the full manual. */
var WK_LEGEND="Pills: a session (filter) or a topic; click to filter.\nL0 the session, L1 coordinates, L2 does the work; └ = child.\nrunning / waiting #n / paused: the job's state.\n? next to a job: what the guard flags (hover).\n⋯ per row: more actions; All jobs ▾: every job.";
function wkBar(q){
 var seen={},chips=(q.table||[]).filter(function(r){return!seen[r.session]&&(seen[r.session]=1)}).map(function(r){return wkChip(r.session,WK_FILTERS.indexOf(r.session)>=0)}).join(" ")+(function(){var ts={};return(q.table||[]).filter(function(r){return r.topic&&!ts[wkTk(r)]&&(ts[wkTk(r)]=1)}).map(function(r){return wkTopic(r,WK_TF.indexOf(wkTk(r))>=0)}).join("")})(),n=(q.table||[]).length,sh=(WK_FILTERS.length||WK_TF.length)?wkView(q.table).length:n,cnt=(WK_FILTERS.length||WK_TF.length)?'<span class="wq-cnt dim" title="active session filter">showing '+sh+' of '+n+'</span>':"";
 var leg=WK_LEGEND;
 // the (i) legend: a CSS tooltip that shows on hover, focus and click/tap (touch screens), not only the native title
 return'<div class="wq-bar"><span class="wq-i" tabindex="0" role="note" data-tip="'+esc(leg)+'" aria-label="legend">(i)<span class="wq-tip" role="tooltip">'+esc(leg)+'</span></span><span class="wq-chips">'+chips+'</span>'+cnt+'<button type="button" class="wq-all'+(WK_MENU&&WK_MENU.key==="all"?' on':'')+'" data-wm="all" aria-haspopup="true" title="actions on every job of the machine">All jobs ▾</button></div>';
}
var WK_NONE='<span class="dim">nothing running or waiting</span>';
var WQ=null,WK_BLOCKS={},WK_DRAG=null;
/** "7m 12s" / "1h 05m"; a negative value (past the deadline) loses its sign — wkLeft words it ("over"). */
function wkDur(s){var x=Math.abs(Math.round(s||0));return x<90?x+"s":x<5400?Math.floor(x/60)+"m"+String(x%60).padStart(2,"0")+"s":Math.floor(x/3600)+"h"+String(Math.floor(x%3600/60)).padStart(2,"0")+"m"}
function wkSpanT(t,full){return' <span title="'+esc(full||t)+'">'+esc(t)+'</span>'}
function wkSpan(t){return' <span title="'+esc(t)+'">'+esc(t)+'</span>'}
function wkCmp(a,b){return a==="other"?1:b==="other"?-1:a<b?-1:a>b?1:0}
function wkBuildRow(b,i){var l=wkSpan(b.label+(b.mode==="full"?" [full]":"")+(b.key?" ["+b.key+"]":""));return[b.state==="running"?"":String(i+1),l,wkSpan(b.session),b.state==="running"?"running":"waiting"+(b.why?" ("+esc(b.why)+")":""),b.chip?wkChip(b.chip,WK_FILTERS.indexOf(b.chip)>=0):'<span class="dim">–</span>',wkDur(b.state==="running"?b.ageSec:b.waitedSec)]}
/** The queue payload as blocks: [{id, title (plain text), head, rows}] in page order. */
function wkInst(q){var p=(q.providers||[]).filter(function(x){return x.instances&&x.instances.length}).map(function(x){return x.provider+" "+x.instances.map(function(i){var m=/#(\d+)$/.exec(i.engine);return"#"+(m?m[1]:"1")+" "+i.busy+"/"+i.cap}).join(" · ")});return p.length?" · "+p.join(" · "):""}
function wkBlocks(q){
 var out=[],sess={},pl=q.plans||[],pv=q.paneViolations||[],bq=q.builds;
 if(pl.length)out.push({id:"plans",title:"plans",head:["plan .txt","parts","phase .txt","in phase","running .txt","workers .txt"],rows:pl.map(function(p){return[wkSpan(p.job),p.merged+'/'+p.total,wkSpan(p.phase),wkDur(p.phaseSec),wkDur(p.ageSec),wkSpan((p.running||[]).join(", "))]})});
 if(pv.length)out.push({id:"violations",title:"pane violations",head:["process .txt","mark .txt","why .txt"],rows:pv.map(function(p){return[wkSpan(p.id),wkSpan(p.mark),wkSpan(p.why||"")]})});
 if(bq&&(bq.running.length||bq.waiting.length))[["test","tests",bq.testSlots],["build","builds",bq.slots]].forEach(function(P){
  var run=bq.running.filter(function(b){return b.kind===P[0]}).map(function(b){b.state="running";return b}),wt=bq.waiting.filter(function(b){return b.kind===P[0]}).map(function(b){b.state="waiting";return b});
  if(!run.length&&!wt.length)return;
  out.push({id:P[1],title:P[1]+" ("+P[2]+" slot"+(P[2]===1?"":"s")+")",head:["pos","build .txt","session .txt","state","session chip","waited"],rows:run.concat(wt).map(wkBuildRow)});
 });
 if((q.table||[]).length||!out.length)out.unshift({id:"queue",title:"worker queue — "+(q.table||[]).length+" job(s)"+wkInst(q),head:[],rows:[],table:true});
 return out;
}
function wkBlockOf(id){return WK_BLOCKS[id]||null}
/** A block's card html: the table (plus its footnote); a block that is gone says so. */
function wkBlockHtml(b){
 if(!b)return WK_NONE;
 // the table rides on the card body (no .tw wrapper): it keeps its fixed columns at every width and never stacks
 if(b.table){var tr=wkView((WQ&&WQ.table)||[]);return wkBar(WQ||{})+wkQTable(tr)+wkMenuHtml()}
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
  // the (i) legend opens its tooltip on click/tap too (touch screens have no hover); a second click closes it
  var ii=T?T.closest(".wq-i"):null;
  if(ii){var was=ii.classList.contains("on");document.querySelectorAll(".wq-i.on").forEach(function(x){x.classList.remove("on")});if(!was)ii.classList.add("on");return}
  document.querySelectorAll(".wq-i.on").forEach(function(x){x.classList.remove("on")});
  var wm=T?T.closest("button[data-wm]"):null;
  if(wm){var k=wm.getAttribute("data-wm"),rc=wm.getBoundingClientRect();WK_MENU=WK_MENU&&WK_MENU.key===k?null:{key:k,x:Math.max(4,Math.min(Math.round(rc.left),window.innerWidth-190)),y:Math.round(rc.bottom)+2};rd();return}
  // the row's inline detail: the ▸ button or a tap anywhere on the row (except its controls) opens it; a tap again collapses
  var cx=T?T.closest("button[data-wqx]"):null;
  if(cx){var xk=cx.getAttribute("data-id")||cx.getAttribute("data-wqx");if(WK_OPEN[xk])delete WK_OPEN[xk];else WK_OPEN[xk]=1;if(T.closest(".wq-menu"))WK_MENU=null;rd();return}
  var trc=T?T.closest("tr.wq-r"):null;
  if(trc&&!T.closest("button,select,a,input,.wq-i")){var xid=trc.getAttribute("data-id");if(WK_OPEN[xid])delete WK_OPEN[xid];else WK_OPEN[xid]=1;rd();return}
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
