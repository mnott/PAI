/** cockpit-page — script: the Memory section (index/embed state, passes, backend, run actions). */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

export const scriptMemory = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`var mem=null,memMsg=null,MEM_STALL=0;
function memDur(s){if(s==null)return"–";s=Math.round(s);return s<90?s+" s":s<5400?Math.floor(s/60)+" m "+String(s%60).padStart(2,"0")+" s":Math.floor(s/3600)+" h "+String(Math.floor(s%3600/60)).padStart(2,"0")+" m"}
function memAt(ms){return ms?new Date(ms).toLocaleString():"never"}
function memLvl(l){return l==="red"?"bad":l==="amber"?"warn":"ok"}
/** The run line: what runs, who started it, chunks done of the backlog at start, rate, ETA, elapsed, the log's last line. */
function memRunLine(r){
 var p=r.backlogStart!=null&&r.backlogStart>0?" ("+(100*r.done/r.backlogStart).toFixed(1)+"%)":"";
 var out=r.kind+" running (started by "+r.by+")";
 if(r.kind==="embed")out+=" · "+fmt(r.done)+(r.backlogStart!=null?" / "+fmt(r.backlogStart):"")+" chunks"+p;
 if(r.rate!=null)out+=" · "+r.rate+"/s";
 if(r.etaSec!=null)out+=" · ETA "+memDur(r.etaSec);
 out+=" · "+memDur(r.elapsedSec);
 if(r.tail)out+=" · "+r.tail;
 return out;
}
function memClock(ms){return new Date(ms).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
function memDot(cls){return'<span style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;background:var(--'+cls+')"></span>'}
function memBound(b){return b?b.backend+(b.model?" / "+b.model:""):"none"}
/** The stacked vectors bar (new backend / old backend still to replace / missing) with its legend counts. */
function memSegs(m){
 var g=m.segments;if(!g)return'<div class="mt-sub">vector split not known yet</div>';
 var t=g.fresh+g.old+g.missing,w=function(v){return t>0?(100*v/t).toFixed(2):"0"};
 function seg(v,c){return v>0?'<i style="display:block;height:100%;width:'+w(v)+'%;background:var(--'+c+')"></i>':""}
 function lg(c,txt,v){return'<span style="white-space:nowrap">'+memDot(c)+esc(txt)+' <b>'+esc(String(v))+'</b></span>'}
 return'<div data-part="segments" style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--line)">'+seg(g.fresh,"ok")+seg(g.old,"acc")+seg(g.missing,"warn")+'</div>'+
  '<div class="mt-sub" style="white-space:normal;display:flex;flex-wrap:wrap;gap:2px 12px">'+(m.reembedding?lg("ok","new backend",g.fresh):"")+lg("acc",m.reembedding?"old backend, still to replace":"embedded",g.old)+lg("warn","missing",g.missing)+'</div>';
}
function memIndexTile(m){
 var c=m.counts||{},b=m.binding,x="";
 x+=memSegs(m);
 if(b)x+='<div class="mt-sub" title="the backend the stored vectors were made with / the one configured now">bound to '+esc(memBound(b.bound))+' · configured '+esc(b.configured.backend+" / "+b.configured.model)+'</div>';
 if(b&&(b.error||b.hint))x+='<div class="mt-sub '+(b.error||b.mismatch?"bad":"warn")+'" style="white-space:normal">'+esc(b.error?"binding error: "+b.error:b.hint)+'</div>';
 return metricTile({title:"Index",value:c.coverage==null?null:(100*c.coverage).toFixed(1),unit:"%",sub:c.embedded==null?"embedded count not known":"embedded of "+fmt(c.chunks)+" chunks"+(c.exact?"":" (est.)"),
  secondary:{value:c.files==null?null:fmt(c.files),unit:"",sub:"files"},extra:x,series:[]});
}
function memBackendTile(m){
 var b=m.backend;
 if(!b)return metricTile({title:"Backend",value:null,unit:"",sub:"not known",series:[]});
 var st=b.available===false?"unavailable":b.available?"available":"not probed",cl=b.available===false?"bad":b.available?"ok":"dim";
 var x='<div class="mt-sub" style="white-space:normal">'+memDot(b.available===false?"bad":b.available?"ok":"dim")+'<span class="'+cl+'">'+st+'</span>'+(b.reason?' · '+esc(b.reason):'')+'</div>'+
  '<div class="mt-sub" title="'+esc(b.model||"")+'">'+(b.loadedModel?'loaded: '+esc(b.loadedModel):esc(b.model||"–")+' (not loaded)')+(b.dims?' · '+b.dims+' dims':'')+'</div>';
 var gs=b.gpuShare;
 return metricTile({title:"Backend",value:b.id,unit:"",sub:st,extra:x,series:[],
  fill:gs==null?null:{pct:100*gs,text:"GPU share "+Math.round(100*gs)+"%",tone:gs<1?"warn":"ok"}});
}
function memJobTile(j){
 var ring=j.pct==null?emptyRing(${n(L.memoryRingPx)}):donut(j.pct/100,${n(L.memoryRingPx)},j.stalled?"bad":"acc");
 var lines=[];
 lines.push('<span>'+(j.rate==null?"–":j.rate.toFixed(1))+' chunks/s</span>');
 lines.push('<span>'+fmt(j.done)+(j.total!=null?" / "+fmt(j.total):"")+' done</span>');
 lines.push('<span>ETA '+(j.etaSec==null?"–":memDur(j.etaSec))+(j.doneAt?' · done about '+memClock(j.doneAt):'')+'</span>');
 lines.push('<span class="dim">'+esc(j.phase)+(j.lastProgressAt?' · last progress '+memClock(j.lastProgressAt):'')+(j.by?' · by '+esc(j.by):'')+'</span>');
 var x='<div data-part="job" style="display:flex;gap:10px;align-items:center"><div>'+ring+'</div><div class="mt-sub" style="white-space:normal;display:flex;flex-direction:column;gap:2px">'+lines.join("")+
  (j.stalled?'<b class="bad" data-part="stalled">STALLED: no progress for '+memDur(MEM_STALL)+'</b>':'')+'</div></div>';
 return metricTile({title:(j.kind==="reembed"?"Re-embed ":"")+j.name,value:j.pct==null?null:j.pct.toFixed(1),unit:"%",sub:"rate, last hour",extra:x,series:[{data:j.series||[]}]});
}
function memTimeline(p,now){
 var lo=p.lastEnd,hi=p.nextAt,x='<svg viewBox="0 0 100 16" preserveAspectRatio="none" width="100%" height="16"><line x1="4" y1="8" x2="96" y2="8" stroke="var(--line)" stroke-width="2"/>';
 var col=p.state==="failed"?"bad":p.state==="running"?"warn":"ok";
 if(lo)x+='<ellipse cx="4" cy="8" rx="2.2" ry="5" fill="var(--'+col+')"/>';
 if(hi)x+='<ellipse cx="96" cy="8" rx="2.2" ry="5" fill="none" stroke="var(--dim)" stroke-width="1.5"/>';
 if(lo&&hi&&hi>lo){var f=Math.max(0,Math.min(1,(now-lo)/(hi-lo)));x+='<line x1="'+(4+92*f).toFixed(1)+'" y1="3" x2="'+(4+92*f).toFixed(1)+'" y2="13" stroke="var(--fg)" stroke-width="1"/>'}
 return x+'</svg>';
}
function memPassesTile(m){
 var ps=m.passes||[],x="";
 ps.forEach(function(p){
  var col=p.state==="failed"?"bad":p.state==="running"?"warn":"ok",d=p.detail;
  x+='<div data-part="pass" style="margin-top:4px"><div>'+memDot(col)+'<b>'+esc(p.name)+'</b> <span class="'+col+'">'+p.state+'</span></div>'+memTimeline(p,m.at)+
   '<div class="mt-sub">last '+(p.lastEnd?memAt(p.lastEnd):"none since start")+(p.nextAt?' · next '+memAt(p.nextAt):'')+'</div>'+
   (p.name==="index"&&m.lastIndex?'<div class="mt-sub">'+fmt(m.lastIndex.files)+' files, '+fmt(m.lastIndex.chunks)+' chunks · took '+memDur(m.lastIndex.durationSec)+'</div>':'')+
   (d?'<div class="mt-sub" title="the last recorded embed pass">embedded '+fmt(d.embedded)+(d.backlogLeft!=null?' · '+fmt(d.backlogLeft)+' left':'')+' · '+esc(d.stopReason)+(d.note?' ('+esc(d.note)+')':'')+'</div>':'')+
   (p.failure?'<div class="mt-sub bad" style="white-space:normal">'+esc(p.failure.error)+' ('+(p.failure.gaveUp?"gave up until next scheduled run":p.failure.retryAt?"retry at "+memAt(p.failure.retryAt):"no retry scheduled")+')</div>':'')+'</div>';
 });
 var sc=m.schedule;
 if(sc)x+='<div class="mt-sub">'+(sc.maintenanceHour!=null?"nightly maintenance at "+String(sc.maintenanceHour).padStart(2,"0")+":00 (index, then embed)":"index every "+memDur(sc.indexIntervalSecs)+", embed every "+memDur(sc.embedIntervalSecs))+'</div>';
 var bad=ps.some(function(p){return p.state==="failed"});
 return metricTile({title:"Passes",value:ps.length?(bad?"failed":"ok"):null,unit:"",sub:ps.length+" scheduled",extra:x,series:[]});
}
function memDaemonTile(m){
 var d=m.daemonInfo;
 if(!d)return metricTile({title:"Daemon",value:null,unit:"",sub:m.daemon?"status not sampled yet":"daemon not answering",series:[]});
 return metricTile({title:"Daemon",value:memDur(d.uptimeSecs),unit:"",sub:"uptime",extra:'<div class="mt-sub" data-part="daemon">pid '+esc(String(d.pid))+' · v'+esc(d.version)+' · storage '+esc(d.storage)+'</div>',series:[]});
}
function memActions(m){
 var busy=!!(m.run||m.starting),dis=busy||!m.daemon?" disabled":"";
 var line=m.run?memRunLine(m.run):m.starting?"starting…":"";
 return'<div style="margin-top:8px" class="act" data-rt="memory">'+
  '<button data-a="memory.embed"'+dis+' title="the same as pai memory embed --all --background">embed backlog</button>'+
  '<button data-a="memory.index"'+dis+' title="one index pass">index now</button>'+
  (m.run&&m.run.stoppable?'<button data-a="memory.stop" title="stops cleanly; re-run to continue">stop</button>':'')+
  '<span class="msg'+(m.run||m.starting||(!memMsg&&(!m.lastRun||m.lastRun.ok))?"":" bad")+'" title="'+esc(line||(m.lastRun&&m.lastRun.message)||"")+'">'+esc(line||(memMsg&&memMsg.text)||(m.lastRun?m.lastRun.op+": "+m.lastRun.message:""))+'</span></div>';
}
function memHtml(m){
 var pill=!m.daemon?"daemon down":m.level==="green"?"healthy":m.level==="amber"?"attention":"problem";
 MEM_STALL=m.stallSecs;
 var h=['<div style="margin-bottom:6px"><b data-part="pill" class="'+memLvl(m.level)+'">'+esc(pill)+'</b> <span class="dim">'+esc(m.reason||"")+'</span></div>'];
 h.push('<div class="rt-tiles" data-tkey="mem">'+memIndexTile(m)+memBackendTile(m)+(m.jobs||[]).map(memJobTile).join("")+memPassesTile(m)+memDaemonTile(m)+'</div>');
 h.push(memActions(m));
 return h.join("");
}
function renderMemory(){
 var el=$("memorypanel");
 if(!mem){if(!el.__html)setHtml(el,'<span class="dim">memory status unavailable</span>');return}
 if(!setHtml(el,memHtml(mem)))return;
 orderTiles(el);
 var bs=el.querySelectorAll(".act button");
 for(var i=0;i<bs.length;i++)(function(b){b.onclick=function(){
  for(var k=0;k<bs.length;k++)bs[k].disabled=true;
  postAction(b.getAttribute("data-a"),null,null,function(j){memMsg=j&&j.ok?null:{text:(j&&j.message)||"action failed",ok:false};loadMemory()});
 }})(bs[i]);
}
function loadMemory(){fetch("/cockpit/memory",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){mem=j;lastOk=Date.now();renderMemory()}).catch(function(){})}
`;
