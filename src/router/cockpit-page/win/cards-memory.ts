/** cockpit-page/win — `memory`: the Memory index group on the win runtime.
 *  Page-scope ES5 (after scriptCore + scriptMemory: esc/fmt/memDur/memAt/memClock/memBound/memLvl/memRunLine in scope),
 *  needs `Win`, `WinT` and `WinA` (the action runner, win/actions.ts). Feed `memory` (/cockpit/memory).
 *  Group `memory`: `kv` card `memory.kv` (pill + reason; the run progress is a line under the pill, never in a header),
 *  `metric` cards `memory.index|backend|passes|daemon` and one dynamic `metric` card `memory.job:<id>` per job (Win.addCards).
 *  index now / embed backlog / stop are header actions of the group card, disabled with their reason in the title; results go
 *  through WinA.runAction into the group card's status slot. The `kv`/`metric` types are the generic ones of win/types.ts;
 *  the cards here carry memKvView / memMetricView. */

export const WIN_MEMORY_JS = String.raw`var MEM_INFO="Memory index: how much of the store is embedded, the backend, running jobs, scheduled passes and the daemon.";
var WMEM=null,WMEM_JOBS={};
function memBusy(m){return!!(m&&(m.run||m.starting))}
/** The group's three actions: [id, label, verb, enabled(m) -> true | reason]. */
var MEM_ACTS=[
 ["index","index now","memory.index",function(m){return!m||!m.daemon?"daemon not answering":memBusy(m)?"a run is in progress":true}],
 ["embed","embed backlog","memory.embed",function(m){return!m||!m.daemon?"daemon not answering":memBusy(m)?"a run is in progress":m.counts&&m.counts.backlog===0?"nothing to embed (backlog 0)":true}],
 ["stop","stop","memory.stop",function(m){return m&&m.run&&m.run.stoppable?true:"nothing to stop"}]
];
/** The group header carries only the title and the buttons: a pending run shows no text there (progress lives in the status card). */
var MEM_HOST=null;
function memHost(){
 if(!MEM_HOST){MEM_HOST=Object.create(WIN_HOST);MEM_HOST.setStatus=function(id,k,t){WIN_HOST.setStatus(id,k==="pending"?"":k,k==="pending"?"":t)}}
 return MEM_HOST;
}
function memAction(a){
 return{id:a[0],label:a[1],title:a[0]==="stop"?"stops cleanly; re-run to continue":"",
  enabled:function(){return a[3](WMEM)},
  run:function(){WinA.runAction("memory",a[2],{},Win.el("memory").querySelector('[data-act="'+a[0]+'"]'),memHost())}};
}
/** The running pill text (kind, percent, rate, ETA), empty when nothing runs. */
function memPillText(m){
 var r=m&&m.run;
 if(!r)return m&&m.starting?"starting…":"";
 var p=r.kind==="embed"&&r.backlogStart>0?" "+Math.round(100*r.done/r.backlogStart)+"%":"";
 return(r.kind==="embed"?"embedding":"indexing")+p+(r.rate!=null?" · "+r.rate+"/s":"")+(r.etaSec!=null?" · ETA "+memDur(r.etaSec):"")+(r.kind==="index"||r.etaSec==null?" · "+memDur(r.elapsedSec):"");
}
/** The status card's run line: the pill text with spaced percent and the rate in chunks/s. */
function memRunStatus(m){return memPillText(m).replace(/(\d)%/,"$1 %").replace(/\/s\b/," chunks/s")}
function memKvView(m){
 if(!m)return null;
 var pill=!m.daemon?"daemon down":m.level==="green"?"healthy":m.level==="amber"?"attention":"problem";
 var run=memRunStatus(m),d={v:'<span class="'+memLvl(m.level)+'">'+esc(pill)+'</span>',s:esc(m.reason||"")+(run?'<span data-part="run" style="display:block">'+esc(run)+'</span>':""),status:["",""]};
 if(m.run)d.t=memRunLine(m.run);
 return d;
}
function memLine(cls,html){return'<div class="mt-sub'+(cls?" "+cls:"")+'">'+html+'</div>'}
function memSegBar(m){
 var g=m.segments;if(!g)return memLine("","vector split not known yet");
 var t=g.fresh+g.old+g.missing,w=function(v){return t>0?(100*v/t).toFixed(2):"0"};
 function seg(v,c){return v>0?'<i style="display:block;height:100%;width:'+w(v)+'%;background:var(--'+c+')"></i>':""}
 return'<div data-part="segments" style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--line)">'+seg(g.fresh,"ok")+seg(g.old,"acc")+seg(g.missing,"warn")+'</div>'+
  memLine("",(m.reembedding?"new "+fmt(g.fresh)+" · old, to replace "+fmt(g.old):"embedded "+fmt(g.old))+" · missing "+fmt(g.missing));
}
/** m:ss (h:mm:ss from an hour) for the progress lines. */
function memRunClock(s){s=Math.max(0,Math.round(s||0));var h=Math.floor(s/3600),mi=Math.floor(s%3600/60),se=String(s%60).padStart(2,"0");return h?h+":"+String(mi).padStart(2,"0")+":"+se:mi+":"+se}
/** The bar and line of a live run record (m.runs[kind]); "" when none runs. Index: "120/254 projects · 1:40"; embed: "embedding: N/M this run · R/min · ETA". */
function memRunProgress(r){
 if(!r)return"";
 if(r.state==="ended")return memLine("warn",esc(r.kind)+" run ended without finishing ("+fmt(r.done)+(r.total?"/"+fmt(r.total):"")+" "+esc(r.unit)+")");
 var pct=r.total>0?Math.min(100,100*r.done/r.total):null,stall=r.stalledSec!=null?" · no progress for "+memDur(r.stalledSec):"";
 var bar='<div data-part="runbar-'+r.kind+'" style="height:6px;border-radius:3px;overflow:hidden;background:var(--line)"><i style="display:block;height:100%;width:'+(pct==null?0:pct.toFixed(1))+'%;background:var(--acc)"></i></div>';
 var txt=r.kind==="embed"
  ?"embedding: "+fmt(r.done)+"/"+(r.total>0?fmt(r.total):"?")+" this run"+(r.ratePerMin!=null?" · "+fmt(r.ratePerMin)+"/min":"")+(r.etaSec!=null?" · ETA "+memRunClock(r.etaSec):"")
  :"indexing: "+fmt(r.done)+"/"+(r.total>0?fmt(r.total):"?")+" "+esc(r.unit)+" · "+memRunClock(r.elapsedSec)+(r.etaSec!=null?" · ETA "+memRunClock(r.etaSec):"")+(r.current?" · "+esc(r.current):"");
 return bar+memLine(r.stalledSec!=null?"warn":"",txt+stall);
}
/** What each memory card shows: {v, u, s, x(html)}; v null = no value. */
function memIndexView(m){
 var c=m.counts||{},b=m.binding,x=(m.runs?memRunProgress(m.runs.index)+memRunProgress(m.runs.embed):"")+memSegBar(m);
 if(m.indexWarning)x+=memLine("bad",esc(m.indexWarning));
 if(b)x+=memLine("",'bound to '+esc(memBound(b.bound))+' · configured '+esc(b.configured.backend+" / "+b.configured.model));
 if(b&&(b.error||b.hint))x+=memLine(b.error||b.mismatch?"bad":"warn",esc(b.error?"binding error: "+b.error:b.hint));
 return{v:c.coverage==null?null:(100*c.coverage).toFixed(1),u:"%",s:(c.embedded==null?"embedded count not known":"embedded of "+fmt(c.chunks)+" chunks"+(c.exact?"":" (est.)"))+(c.files==null?"":" · "+fmt(c.files)+" files"),x:x};
}
function memBackendView(m){
 var b=m.backend;
 if(!b)return{v:null,u:"",s:"not known",x:""};
 var st=b.available===false?"unavailable":b.available?"available":"not probed",cl=b.available===false?"bad":b.available?"ok":"dim";
 var x=memLine("",'<span class="'+cl+'">'+st+'</span>'+(b.reason?" · "+esc(b.reason):""))+
  memLine("",b.loadedModel?"loaded: "+esc(b.loadedModel):esc(b.model||"–")+" (not loaded)")+(b.dims?memLine("",b.dims+" dims"):"")+
  (b.alsoLoaded&&b.alsoLoaded.length?memLine("dim","also loaded: "+esc(b.alsoLoaded.join(", "))):"");
 var gs=b.gpuShare;
 return{v:b.id,u:"",s:st+(gs==null?"":" · GPU share "+Math.round(100*gs)+"%"),x:x};
}
function memJobView(j,m){
 if(j.finished){
  var f=j.finished,ok=f.outcome==="done",bad=f.outcome==="failed";
  return{v:j.pct==null?null:j.pct.toFixed(1),u:"%",s:"finished · "+(ok?"ok":bad?"failed":esc(f.outcome)),
   x:memLine("",fmt(j.done)+(j.total!=null?" / "+fmt(j.total):"")+" done · took "+memDur(f.durationSec)+(j.rate!=null?" · "+j.rate.toFixed(1)+" chunks/s average":""))+memLine("dim","ended "+memAt(f.endedAt)+(j.by?" · by "+esc(j.by):""))+(f.reason&&!ok?memLine("warn",esc(f.reason)):"")};
 }
 var run=m&&m.run&&j.id==="run-"+m.run.kind?m.run:null;
 var x=memLine("",fmt(j.done)+(j.total!=null?" / "+fmt(j.total):"")+" done · ETA "+(j.etaSec==null?"–":memDur(j.etaSec))+(j.doneAt?" · about "+memClock(j.doneAt):""))+
  memLine("dim",esc(j.phase)+(j.lastProgressAt?" · last progress "+memClock(j.lastProgressAt):"")+(j.by?" · by "+esc(j.by):""))+
  (run&&run.tail?memLine("dim",esc(run.tail)):"")+(j.stalled?memLine("bad","STALLED: no progress for "+memDur(m.stallSecs)):"");
 return{v:j.pct==null?null:j.pct.toFixed(1),u:"%",s:(j.rate==null?"–":j.rate.toFixed(1))+" chunks/s"+(j.phase==="starting"?" · starting…":""),x:x};
}
function memPassesView(m){
 var ps=m.passes||[],x="",bad=ps.some(function(p){return p.state==="failed"});
 ps.forEach(function(p){
  var col=p.state==="failed"?"bad":p.state==="running"?"warn":"ok";
  x+=memLine("",'<b>'+esc(p.name)+'</b> <span class="'+col+'">'+p.state+'</span> · last '+(p.last?memAt(p.last.at)+(p.last.chunks!=null?" · "+fmt(p.last.chunks)+" chunks":"")+" · "+esc(p.last.result)+(p.last.by?" · by "+esc(p.last.by):""):p.lastEnd?memAt(p.lastEnd):"none since start")+(p.nextAt?" · next "+memAt(p.nextAt):""));
  if(p.failure)x+=memLine("bad",esc(p.failure.error)+" ("+(p.failure.gaveUp?"gave up until next scheduled run":p.failure.retryAt?"retry at "+memAt(p.failure.retryAt):"no retry scheduled")+")");
 });
 var sc=m.schedule;
 if(sc)x+=memLine("dim",sc.maintenanceHour!=null?"nightly maintenance at "+String(sc.maintenanceHour).padStart(2,"0")+":00 (index, then embed)":"index every "+memDur(sc.indexIntervalSecs)+", embed every "+memDur(sc.embedIntervalSecs));
 return{v:ps.length?(bad?"failed":"ok"):null,u:"",s:ps.length+" scheduled",x:x,tone:bad?"bad":""};
}
/** Lessons card: a count per state (whole chips that wrap) and the newest candidates (title + age) waiting for review; read-only. */
function memLessonsView(m){
 var l=m.lessons;
 if(!l)return{v:null,u:"",s:"not known",x:""};
 var c=l.counts||{},x='<div class="chips" data-part="counts">'+["approved","candidate","rejected","superseded"].map(function(k){return'<span class="chip" data-part="'+k+'"><b>'+(c[k]||0)+'</b> '+k+'</span>'}).join("")+'</div>';
 (l.candidates||[]).forEach(function(k){x+=memLine("dim",esc(k.title)+(k.ageSec==null?"":" · "+memDur(k.ageSec)+" ago"))});
 return{v:String(c.candidate||0),u:"",s:"awaiting review",x:x};
}
function memDaemonView(m){
 var d=m.daemonInfo;
 if(!d)return{v:null,u:"",s:m.daemon?"status not sampled yet":"daemon not answering",x:""};
 return{v:memDur(d.uptimeSecs),u:"",s:"uptime",x:memLine("","pid "+esc(String(d.pid))+" · v"+esc(d.version)+" · storage "+esc(d.storage))};
}
function memMetricView(m,ctx){
 if(!m)return null;
 var id=ctx.id.slice(7),v,status=null;
 if(id==="index")v=memIndexView(m);
 else if(id==="backend")v=memBackendView(m);
 else if(id==="passes")v=memPassesView(m);
 else if(id==="daemon")v=memDaemonView(m);
 else if(id==="lessons")v=memLessonsView(m);
 else{
  var j=(m.jobs||[]).filter(function(x){return"job:"+x.id===id})[0];
  if(!j)return null;
  status=["",""];v=memJobView(j,m);
 }
 return{v:v.v==null?"–":v.v,u:v.v==null?"":v.u,s:v.s,x:v.x,cls:{bad:v.tone==="bad"},status:status};
}
/** A job that left the payload (finished, or its record is stale) loses its card: only live runs and the Last-run cards show. */
function memJobPrune(m){
 var live={},gone=[],id,i,list=(m&&m.jobs)||[];
 for(i=0;i<list.length;i++)live["memory.job:"+list[i].id]=1;
 for(id in WMEM_JOBS)if(!live[id])gone.push(id);
 if(!gone.length)return;
 for(i=0;i<gone.length;i++)delete WMEM_JOBS[gone[i]];
 Win.removeCards("memory",gone);
}
/** One metric card per job, added by data (a structural change). */
function memJobSync(m){
 var specs=[],rows=[],list=(m&&m.jobs)||[],i;
 for(i=0;i<list.length;i++){
  var id="memory.job:"+list[i].id;
  if(WMEM_JOBS[id])continue;
  WMEM_JOBS[id]=1;
  specs.push({id:id,type:"metricm",title:(list[i].finished?"Last ":"")+(list[i].kind==="reembed"?"Re-embed ":"")+list[i].name,feeds:["memory"],view:memMetricView});
  rows.push([id]);
 }
 if(specs.length&&Win.addCards("memory",specs,rows))Win.update("memory",m);
}
/** The memory feed: remember the payload for the actions' enabled(), push it to the cards, then add job cards. */
function winFeedMemory(m){WMEM=m;if(m)memJobPrune(m);Win.update("memory",m);memJobSync(m)}
function memDefaults(){
 var cards=[{id:"memory",type:"group",title:"Memory",info:MEM_INFO,feeds:["memory"],actions:MEM_ACTS.map(memAction)}],names=["index","backend","passes","lessons","daemon"],ch=[],i;
 cards.push({id:"memory.kv",type:"kv",title:"status",feeds:["memory"],view:memKvView});
 for(i=0;i<names.length;i++){
  cards.push({id:"memory."+names[i],type:"metricm",title:names[i]==="index"?"Index":names[i]==="backend"?"Backend":names[i]==="passes"?"Passes":names[i]==="lessons"?"Lessons":"Daemon",feeds:["memory"],view:memMetricView});
  ch.push(WinT.leaf("memory."+names[i]));
 }
 var row=WinT.split("r",ch,ch.map(function(){return 1/ch.length}));
 return{tree:WinT.leaf("memory"),kids:{memory:WinT.split("c",[WinT.leaf("memory.kv"),row],[0.25,0.75])},stDefaults:{},cards:cards};
}
`;
