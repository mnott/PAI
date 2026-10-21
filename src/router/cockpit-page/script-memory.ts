/** cockpit-page — script: the Memory section (index/embed state, passes, backend, run actions). */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

export const scriptMemory = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`var mem=null,memMsg=null;
function memDur(s){if(s==null)return"–";s=Math.round(s);return s<90?s+" s":s<5400?Math.floor(s/60)+" m "+String(s%60).padStart(2,"0")+" s":Math.floor(s/3600)+" h "+String(Math.floor(s%3600/60)).padStart(2,"0")+" m"}
function memAt(ms){return ms?new Date(ms).toLocaleString():"never"}
function memLvl(l){return l==="red"?"bad":l==="amber"?"warn":"ok"}
function memKpi(label,val,cls,tip){return'<div class="kpi"'+(tip?' title="'+esc(tip)+'"':"")+'><b'+(cls?' class="'+cls+'"':"")+'>'+esc(val)+'</b><span>'+esc(label)+'</span></div>'}
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
function memHtml(m){
 var c=m.counts||{},h=[];
 h.push('<div style="margin-bottom:6px"><b class="'+memLvl(m.level)+'">'+(m.daemon?esc(m.level):"daemon down")+'</b> <span class="dim">'+esc(m.reason||"")+'</span></div>');
 h.push('<div class="kpis">'+
  memKpi("files",c.files==null?"–":fmt(c.files),"")+
  memKpi("chunks",c.chunks==null?"–":fmt(c.chunks),"",c.exact?"exact count":"estimate (catalog statistics)")+
  memKpi("with vectors",c.embedded==null?"–":fmt(c.embedded),"")+
  memKpi("without vectors",c.backlog==null?"–":String(c.backlog),c.coverageLevel?memLvl(c.coverageLevel):"","the embed backlog")+
  memKpi("coverage",c.coverage==null?"–":(100*c.coverage).toFixed(1)+"%",c.coverageLevel?memLvl(c.coverageLevel):"")+
  '</div>');
 var b=m.backend;
 if(b)h.push('<div style="margin-top:8px"><b>Backend</b> '+esc(b.id)+' · '+esc(b.model||"–")+(b.dims?' · '+b.dims+' dims':'')+' · <span class="'+(b.available===false?"bad":b.available?"ok":"dim")+'">'+(b.available===false?"unavailable: "+esc(b.reason||""):b.available?"available":"not probed")+'</span>'+
  (b.loaded&&b.loaded.length?' <span class="dim">loaded: '+b.loaded.map(function(x){return esc(x.name)+(x.gpuShare!=null?" "+Math.round(100*x.gpuShare)+"% GPU":"")}).join(", ")+'</span>':'')+'</div>');
 if(m.binding&&(m.binding.hint||m.binding.error))h.push('<div class="bad">'+esc(m.binding.error||m.binding.hint)+'</div>');
 var li=m.lastIndex,le=m.lastEmbed,sc=m.schedule,rows=[];
 rows.push(["index",li?memAt(li.at):"never",li?memDur(li.durationSec):"–",li?fmt(li.files)+" files, "+fmt(li.chunks)+" chunks":"–"]);
 rows.push(["embed",le?memAt(le.at):"never",le&&le.durationSec!=null?memDur(le.durationSec):"–",le?fmt(le.chunks)+" chunks · "+esc(le.outcome)+(le.reason?" ("+esc(le.reason)+")":""):"–"]);
 h.push('<div style="margin-top:8px"><b>Passes</b>'+table(["pass .txt","last .txt","took","result .txt"],rows)+'</div>');
 if(sc)h.push('<div class="dim">'+(sc.maintenanceHour!=null?"nightly maintenance at "+String(sc.maintenanceHour).padStart(2,"0")+":00 (index, then embed)":"index every "+memDur(sc.indexIntervalSecs)+", embed every "+memDur(sc.embedIntervalSecs))+'</div>');
 var pf=(m.passes||[]).filter(function(p){return p.failure});
 pf.forEach(function(p){h.push('<div class="bad">pass '+esc(p.name)+' failed: '+esc(p.failure.error)+(p.failure.gaveUp?" (gave up)":p.failure.retryAt?" · retry "+memAt(p.failure.retryAt):"")+'</div>')});
 (m.jobs||[]).forEach(function(j){h.push('<div class="'+(j.stalled?"bad":"dim")+'">job '+esc(j.name)+' · '+esc(j.phase)+' · '+fmt(j.done)+(j.total?' / '+fmt(j.total):'')+(j.rate!=null?' · '+j.rate.toFixed(1)+'/s':'')+(j.etaSec!=null?' · ETA '+memDur(j.etaSec):'')+(j.stalled?' · STALLED':'')+'</div>')});
 var busy=!!(m.run||m.starting),dis=busy||!m.daemon?" disabled":"";
 var line=m.run?memRunLine(m.run):m.starting?"starting…":"";
 h.push('<div style="margin-top:8px" class="act" data-rt="memory">'+
  '<button data-a="memory.embed"'+dis+' title="the same as pai memory embed --all --background">embed backlog</button>'+
  '<button data-a="memory.index"'+dis+' title="one index pass">index now</button>'+
  (m.run&&m.run.stoppable?'<button data-a="memory.stop" title="stops cleanly; re-run to continue">stop</button>':'')+
  '<span class="msg'+(m.run||m.starting||(!memMsg&&(!m.lastRun||m.lastRun.ok))?"":" bad")+'" title="'+esc(line||(m.lastRun&&m.lastRun.message)||"")+'">'+esc(line||(memMsg&&memMsg.text)||(m.lastRun?m.lastRun.op+": "+m.lastRun.message:""))+'</span></div>');
 return h.join("");
}
function renderMemory(){
 var el=$("memorypanel");
 if(!mem){if(!el.__html)setHtml(el,'<span class="dim">memory status unavailable</span>');return}
 if(!setHtml(el,memHtml(mem)))return;
 var bs=el.querySelectorAll(".act button");
 for(var i=0;i<bs.length;i++)(function(b){b.onclick=function(){
  for(var k=0;k<bs.length;k++)bs[k].disabled=true;
  postAction(b.getAttribute("data-a"),null,null,function(j){memMsg=j&&j.ok?null:{text:(j&&j.message)||"action failed",ok:false};loadMemory()});
 }})(bs[i]);
}
function loadMemory(){fetch("/cockpit/memory",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){mem=j;lastOk=Date.now();renderMemory()}).catch(function(){})}
`;
