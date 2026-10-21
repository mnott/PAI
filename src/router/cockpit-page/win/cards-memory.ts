/** cockpit-page/win — B3 `memory`: the Memory index group on the win runtime (spec 7/B3).
 *  Page-scope ES5 (after scriptCore + scriptMemory: esc/fmt/memDur/memAt/memClock/memBound/memLvl/memRunLine in scope),
 *  needs `Win`, `WinT` and `WinA` (the action runner, win/actions.ts). Feed `memory` (/cockpit/memory).
 *  Group `memory`: `kv` card `memory.kv` (pill + reason; the running pill sits in its status slot as ctx.status("run", ...)),
 *  `metric` cards `memory.index|backend|passes|daemon` and one dynamic `metric` card `memory.job:<id>` per job (Win.addCards).
 *  embed / index now / stop are header actions of the group card, disabled with their reason in the title; results go
 *  through WinA.runAction into the group card's status slot. The `kv`/`metric` types are the generic ones of win/types.ts;
 *  the cards here carry memKvView / memMetricView. */

export const WIN_MEMORY_JS = String.raw`var MEM_INFO="Memory index: how much of the store is embedded, the backend, running jobs, scheduled passes and the daemon.";
var WMEM=null,WMEM_JOBS={};
function memBusy(m){return!!(m&&(m.run||m.starting))}
/** The group's three actions: [id, label, verb, enabled(m) -> true | reason]. */
var MEM_ACTS=[
 ["embed","embed backlog","memory.embed",function(m){return!m||!m.daemon?"daemon not answering":memBusy(m)?"a run is in progress":m.counts&&m.counts.backlog===0?"nothing to embed (backlog 0)":true}],
 ["index","index now","memory.index",function(m){return!m||!m.daemon?"daemon not answering":memBusy(m)?"a run is in progress":true}],
 ["stop","stop","memory.stop",function(m){return m&&m.run&&m.run.stoppable?true:"nothing to stop"}]
];
function memAction(a){
 return{id:a[0],label:a[1],title:a[0]==="stop"?"stops cleanly; re-run to continue":"",
  enabled:function(){return a[3](WMEM)},
  run:function(){WinA.runAction("memory",a[2],{},Win.el("memory").querySelector('[data-act="'+a[0]+'"]'),WIN_HOST)}};
}
/** The running pill text (kind, percent, rate, ETA), empty when nothing runs. */
function memPillText(m){
 var r=m&&m.run;
 if(!r)return m&&m.starting?"starting…":"";
 var p=r.kind==="embed"&&r.backlogStart>0?" "+Math.round(100*r.done/r.backlogStart)+"%":"";
 return(r.kind==="embed"?"embedding":"indexing")+p+(r.rate!=null?" · "+r.rate+"/s":"")+(r.etaSec!=null?" · ETA "+memDur(r.etaSec):"")+(r.kind==="index"||r.etaSec==null?" · "+memDur(r.elapsedSec):"");
}
function memKvView(m){
 if(!m)return null;
 var pill=!m.daemon?"daemon down":m.level==="green"?"healthy":m.level==="amber"?"attention":"problem";
 var run=memPillText(m),d={v:'<span class="'+memLvl(m.level)+'">'+esc(pill)+'</span>',s:esc(m.reason||""),status:[run?"run":"",run]};
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
/** What each memory card shows: {v, u, s, x(html)}; v null = no value. */
function memIndexView(m){
 var c=m.counts||{},b=m.binding,x=memSegBar(m);
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
   x:memLine("",fmt(j.done)+(j.total!=null?" / "+fmt(j.total):"")+" done · took "+memDur(f.durationSec))+memLine("dim","ended "+memAt(f.endedAt)+(j.by?" · by "+esc(j.by):""))+(f.reason&&!ok?memLine("warn",esc(f.reason)):"")};
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
  x+=memLine("",'<b>'+esc(p.name)+'</b> <span class="'+col+'">'+p.state+'</span> · last '+(p.last?memAt(p.last.at)+(p.last.chunks!=null?" · "+fmt(p.last.chunks)+" chunks":"")+" · "+esc(p.last.result):p.lastEnd?memAt(p.lastEnd):"none since start")+(p.nextAt?" · next "+memAt(p.nextAt):""));
  if(p.failure)x+=memLine("bad",esc(p.failure.error)+" ("+(p.failure.gaveUp?"gave up until next scheduled run":p.failure.retryAt?"retry at "+memAt(p.failure.retryAt):"no retry scheduled")+")");
 });
 var sc=m.schedule;
 if(sc)x+=memLine("dim",sc.maintenanceHour!=null?"nightly maintenance at "+String(sc.maintenanceHour).padStart(2,"0")+":00 (index, then embed)":"index every "+memDur(sc.indexIntervalSecs)+", embed every "+memDur(sc.embedIntervalSecs));
 return{v:ps.length?(bad?"failed":"ok"):null,u:"",s:ps.length+" scheduled",x:x,tone:bad?"bad":""};
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
 else{
  var j=(m.jobs||[]).filter(function(x){return"job:"+x.id===id})[0];
  if(!j)return{status:["stale","gone"]};
  status=["",""];v=memJobView(j,m);
 }
 return{v:v.v==null?"–":v.v,u:v.v==null?"":v.u,s:v.s,x:v.x,cls:{bad:v.tone==="bad"},status:status};
}
/** One metric card per job, added by data (a structural change). */
function memJobSync(m){
 var specs=[],rows=[],list=(m&&m.jobs)||[],i;
 for(i=0;i<list.length;i++){
  var id="memory.job:"+list[i].id;
  if(WMEM_JOBS[id])continue;
  WMEM_JOBS[id]=1;
  specs.push({id:id,type:"metricm",title:(list[i].kind==="reembed"?"Re-embed ":"")+list[i].name,feeds:["memory"],view:memMetricView});
  rows.push([id]);
 }
 if(specs.length&&Win.addCards("memory",specs,rows))Win.update("memory",m);
}
/** The memory feed: remember the payload for the actions' enabled(), push it to the cards, then add job cards. */
function winFeedMemory(m){WMEM=m;Win.update("memory",m);memJobSync(m)}
function memDefaults(){
 var cards=[{id:"memory",type:"group",title:"Memory",info:MEM_INFO,feeds:["memory"],actions:MEM_ACTS.map(memAction)}],names=["index","backend","passes","daemon"],ch=[],i;
 cards.push({id:"memory.kv",type:"kv",title:"status",feeds:["memory"],view:memKvView});
 for(i=0;i<names.length;i++){
  cards.push({id:"memory."+names[i],type:"metricm",title:names[i]==="index"?"Index":names[i]==="backend"?"Backend":names[i]==="passes"?"Passes":"Daemon",feeds:["memory"],view:memMetricView});
  ch.push(WinT.leaf("memory."+names[i]));
 }
 var row=WinT.split("r",ch,ch.map(function(){return 1/ch.length}));
 return{tree:WinT.leaf("memory"),kids:{memory:WinT.split("c",[WinT.leaf("memory.kv"),row],[0.25,0.75])},stDefaults:{},cards:cards};
}
`;
