/** cockpit-page/win — `system`: the system metrics, the power chart and the local-server cards.
 *  Page-scope ES5 (runs after scriptCore/scriptCharts helpers exist at call time: fmt, esc, gb, gbm, metricSpark,
 *  trimEmpty, fmtAxis, padFor, labelStep, label) and needs `Win` + `WinT`. Feed `system` (/cockpit/system);
 *  the server cards also read the `data` feed (speed table) and the page's `lim`/`data` globals.
 *  Cards: group `system` > groups `sys-metrics` (14 + 6 `metric` cards `system.<name>`), `sys-power` (chart card
 *  `system.power-chart`), `sys-servers` (the note card `system.srv:none`, shown while no server is up, plus
 *  dynamic: four `metric` cards `system.srv:<provider>/<rss|e2e|decode|prefix>` per up server, added by data
 *  through Win.addCards). The `metric` type itself is registered in cards-kpis;
 *  their cards carry sysMetricView / sysServerView. */

/** The metric table, the history helper `sysSeries`, the metric/server/chart updates and the shipped defaults. */
export const WIN_SYSTEM_JS = String.raw`var SYS_INFO="Memory, load, temperature and power of this machine, and the local model servers.";
var SYS_HIST=60,WSYS={ring:{},last:{}};
/** Last good reading of a key, marked with its age when the payload dropped it: {v, age}. */
function sysRead(c,key){
 var v=c[key];
 if(v!=null){WSYS.last[key]={v:v,at:Date.now()};return{v:v,age:""}}
 var m=WSYS.last[key];return m?{v:m.v,age:staleAge(m,Date.now())}:{v:null,age:""};
}
/** The one history helper of the metric cards: the server's series for the window (sk) when it has one, else the
 *  ring of the last polls, which grows once per payload object (a replay or a second feed adds nothing). */
function sysSeries(d,key,sk,v){
 var ss=(d.series&&d.series.series)||[];
 if(sk){var a=ss.map(function(b){return b[sk]});if(a.filter(function(x){return x!=null}).length>1)return a}
 var r=WSYS.ring[key]||(WSYS.ring[key]={src:null,a:[]});
 if(r.src!==d){r.src=d;r.a.push(v==null?null:v);if(r.a.length>SYS_HIST)r.a.shift()}
 return r.a;
}
/** Unused metric: the window has samples for it and every one is 0 (no samples = unknown). */
function sysUnused(d,key){
 var ss=(d.series&&d.series.series)||[],n=0,i,v,c=d.current||{};
 for(i=0;i<ss.length;i++){v=ss[i][key];if(v==null)continue;if(v!==0)return false;n++}
 return n>0&&!(c[key]>0);
}
function sysPct(v){return String(Math.round(v))}
function sysW1(v){return v.toFixed(1)}
function sysTag(d){var s=d.slowAgeS;return s==null?"":" · "+(s<90?"probe "+s+"s":"cached "+(s<3600?Math.round(s/60)+" min":Math.round(s/3600)+" h"))}
function sysOf(v){return"of "+(v!=null?gb(v,0)+" GB":"n/a")}
/** name -> [title, key, fmt, unit, sub(c,d), server series key, zero-hideable]. */
var SYSM={
 "memory":["memory","memUsed",gb,"GB",function(c){return sysOf(c.memTotal)+" · pressure "+(c.pressureLevel!=null?(100-c.pressureLevel)+"%":"n/a")},"memPct"],
 "swap":["swap","swapUsed",gb,"GB",function(c){return sysOf(c.swapTotal)}],
 "wired":["wired","wired",gb,"GB",function(){return"vm_stat"}],
 "compressed":["compressed","compressed",gb,"GB",function(){return"vm_stat"}],
 "cpu-load":["CPU load","cpu",sysPct,"%",function(){return"all clusters"},"cpu"],
 "gpu-load":["GPU load","gpu",sysPct,"%",function(c,d){var f=c.gpuFreqMhz;return(f?(f/1000).toFixed(1)+" GHz":"IOReport")+sysTag(d)},"gpu"],
 "ane-load":["ANE load","ane",sysPct,"%",function(c,d){return"neural engine"+sysTag(d)},"ane",1],
 "soc-temp":["SoC temp","socTemp",sysW1,"°C",function(c,d){return"IOReport"+sysTag(d)},"socTemp"],
 "cpu-w":["CPU W","cpuW",sysW1,"W",function(c,d){return"CPU rail"+sysTag(d)},"cpuW",1],
 "gpu-w":["GPU W","gpuW",sysW1,"W",function(c,d){return"GPU rail"+sysTag(d)},"gpuW",1],
 "ane-w":["ANE W","aneW",sysW1,"W",function(c,d){return"neural engine"+sysTag(d)},"aneW",1],
 "system-w":["system W","systemW",sysW1,"W",function(c,d){return"system rail"+sysTag(d)},"systemW"],
 "power":["power","totalW",sysW1,"W",function(c,d){return"SoC total"+sysTag(d)},"totalW"]
};
var SYS_NAMES=["memory","swap","wired","compressed","cpu-load","gpu-load","ane-load","soc-temp","cpu-w","gpu-w","ane-w","system-w","power","energy"];
/** Extra read-only cards; battery/charger/power-in sit in sys-power, the rest are minimized in sys-metrics (restore one to show it). name -> [title, info]. */
var SYS_EXTRA=[["battery","battery","Battery charge, on AC or battery; the drain rate shows while discharging. Source: the battery guard's telemetry."],
 ["charger","charger","What the connected charger can supply (W), from the adapter details."],
 ["power-in","power in","Power delivered to the machine by the charger (SystemPowerIn, W)."],
 ["battery-w","battery W","Battery power in W: positive = charging, negative = discharging."],
 ["gpu-freq","GPU frequency","Current GPU clock in MHz (mactop probe)."],
 ["mem-pressure","memory pressure","normal / warn / critical, from the free-memory level (kern.memorystatus_level: 40% or more free = normal, 20-39 = warn, below 20 = critical)."]];
var SYS_DEFAULT_EXTRA=["battery","charger","power-in"];
/** name -> telemetry key of the series (bucketed) for the power cards. */
var SYSP_SERIES={"battery":null,"charger":"adapterW","power-in":"powerInW","battery-w":"batteryW"};
/** One power/pressure card from the feed's power object or current sample; "no reading" when absent. */
function sysExtraView(d,name){
 var p=d.power,c=d.current||{},none=function(sub){return sysMetric("–","",sub||"no reading",sysSeries(d,"x:"+name,SYSP_SERIES[name],null))},age;
 if(name==="gpu-freq"){var f=c.gpuFreqMhz;return f==null?none():sysMetric(String(Math.round(f)),"MHz","mactop"+sysTag(d),sysSeries(d,"gpuFreq",null,f))}
 if(name==="mem-pressure"){var l=c.pressureLevel;return l==null?none():sysMetric(l>=40?"normal":l>=20?"warn":"critical","","free "+Math.round(l)+"%",sysSeries(d,"pressureLevel",null,l))}
 if(!p)return none();
 age=p.ageS>90?" · "+(p.ageS<3600?Math.round(p.ageS/60)+" min":Math.round(p.ageS/3600)+" h")+" old":"";
 if(name==="battery"){
  if(p.pct==null)return none();
  var dr=p.batteryW!=null&&p.batteryW<0,sub=(dr?"on battery":"on AC")+(dr&&p.drainPctPerMin!=null?" · "+Math.abs(p.drainPctPerMin).toFixed(2)+" %/min":"")+age;
  return sysMetric(String(Math.round(p.pct)),"%",sub,sysSeries(d,"battery",null,p.pct));
 }
 var v=name==="charger"?p.adapterW:name==="power-in"?p.powerInW:p.batteryW;
 if(v==null)return none(name==="charger"?"no adapter":null);
 var sub=name==="charger"?"adapter limit":name==="power-in"?"from the charger":(v<0?"discharging":v>0?"charging":"idle");
 return sysMetric(name==="charger"?String(Math.round(v)):sysW1(v),"W",sub+age,sysSeries(d,"p:"+name,SYSP_SERIES[name],v));
}
var SYS_ZERO=["ane-load","cpu-w","gpu-w","ane-w"];
/** One metric card's data: value, unit, sub line, sparkline. */
function sysMetric(v,unit,sub,data){
 return{v:v,u:v==="–"?"":unit,s:sub,spark:'<svg class="mt-spark" viewBox="0 0 100 32" preserveAspectRatio="none" width="100%" height="100%">'+metricSpark([{data:data}])+'</svg>'};
}
/** A system.<name> card from the system payload. */
function sysMetricView(d,ctx){
 if(!d||d.current===undefined)return null;
 var name=ctx.id.slice(7),c=d.current||{};
 if(name==="energy"){
  var wh=(d.series&&d.series.wh&&d.series.wh[win])||0,cov=(d.series&&d.series.coveredMin&&d.series.coveredMin[win])||0;
  return Object.assign({title:"energy "+win},sysMetric(String(wh),"Wh",cov+" min of 1-min samples",sysSeries(d,"wh"+win,null,wh)));
 }
 if(!SYSM[name]){for(var xi=0;xi<SYS_EXTRA.length;xi++)if(SYS_EXTRA[xi][0]===name)return sysExtraView(d,name);return null}
 var m=SYSM[name];
 var tip=(d.unavailable&&d.unavailable.all)?d.unavailable.all:((c.notes||[]).join("; ")||("source: "+(c.source||"none")));
 if(m[6]&&sysUnused(d,m[5]))return sysMetric("0",m[3],"0 in this window",sysSeries(d,m[1],m[5],0));
 var r=sysRead(c,m[1]);
 return sysMetric(r.v==null?"–":m[2](r.v),m[3],(r.age?"~"+r.age+" old · ":"")+(r.v==null?tip:m[4](c,d)),sysSeries(d,m[1],m[5],r.v));
}
function srvDecode(p){var r=((data&&data.speed)||[]).filter(function(x){return x.provider===p&&(x.h1.writeTps!=null||x.h24.writeTps!=null)})[0];return r?(r.h1.writeTps!=null?r.h1.writeTps:r.h24.writeTps):null}
function srvE2eSub(p){var r=((data&&data.speed)||[]).filter(function(x){return x.provider===p})[0];return r&&r.h24.requests?"no requests in the last hour (24 h: "+fmt(r.h24.requests)+(r.h24.ttftP50!=null?", ttft p50 "+(r.h24.ttftP50/1000).toFixed(1)+" s":"")+")":"no requests in the last 24 h"}
/** A system.srv:<provider>/<what> card; reads the page's sys/data/lim, the payload is only the trigger. */
function sysServerView(_d,ctx){
 var id=ctx.id.slice(11),k=id.lastIndexOf("/"),p=id.slice(0,k),what=id.slice(k+1),d=sys;
 if(!d)return null;
 var s=(d.servers||[]).filter(function(x){return x.provider===p})[0];
 if(!s)return{status:["stale","down"]};
 if(s.up===false)return sysMetric("–","", "down",sysSeries(d,"srv:"+p+":"+what,null,null));

 var pc=s.prefixCache,tot=pc?pc.hits+pc.misses:0,v,txt,unit,sub;
 if(what==="rss"){v=s.rssMb;txt=gbm;unit="GB";sub="resident memory"}
 else if(what==="e2e"){v=s.tokensPerSec;txt=String;unit="tok/s";sub=v!=null?(s.tokensPerSecWindow==="24h"?"router, 24 h":s.tokensPerSecWindow==="1h"?"router, last hour":"end to end"):data?srvE2eSub(p):"loading"}
 else if(what==="decode"){v=srvDecode(p);txt=fmt;unit="tok/s";sub="decode"}
 else{v=pc?pc.hitRate:null;txt=function(x){return(x*100).toFixed(1)};unit="%";sub=pc?pc.hits+"/"+tot:lim?"server reports no prefix-cache counter":"loading: first limits poll pending"}
 return Object.assign({status:["",""]},sysMetric(v==null?"–":txt(v),unit,sub,sysSeries(d,"srv:"+p+":"+what,null,v)));
}
/** The note shown while no local server is up. */
function sysSrvNoneView(){return{text:"no local model server is up"}}
var WCH={};
/** Per-id chart hooks {mount,update,resize} for the data charts (cards-charts); the power chart is the default. */
/** The power/GPU/CPU line chart as a string at an explicit pixel box (no DOM measuring). */
function sysChartSvg(d,w,h){
 var ss=(d.series&&d.series.series)||[],keys=PKEYS;
 var tr=trimEmpty(ss.map(function(b){return label(b.t,d.window)}),ss,function(s){var t=0;keys.forEach(function(k){t+=s[k[0]]||0});return t});
 var svg='<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">';
 if(!tr)return svg+'<text x="'+w/2+'" y="'+h/2+'" text-anchor="middle">no data in this window</text></svg>';
 var labels=tr.labels,rows=tr.rows,padR=padFor(["100%"])+2,padB=18,padT=10,n=labels.length,leftMax=1,hasR=false;
 keys.forEach(function(k){if(k[3])hasR=true;else rows.forEach(function(s){if((s[k[0]]||0)>leftMax)leftMax=s[k[0]]})});
 var padL=padFor([fmtAxis(leftMax)+" W"]),W=w-padL-padR,H=h-padB-padT,bw=W/n,PCT=["0","33","66","100"],g,yy;
 for(g=0;g<=3;g++){yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(w-padR)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(padL-4)+'" y="'+(yy+3)+'" text-anchor="end">'+fmtAxis(leftMax*g/3)+' W</text>'+(hasR?'<text x="'+(w-2)+'" y="'+(yy+3)+'" text-anchor="end">'+PCT[g]+'%</text>':'')}
 keys.forEach(function(k){
  var scale=k[3]?100:leftMax,dd="",pen=false;
  rows.forEach(function(s,i){var v=s[k[0]];if(v==null){pen=false;return}dd+=(pen?"L":"M")+(padL+i*bw+bw/2).toFixed(1)+' '+(padT+H-(v/scale)*H).toFixed(1);pen=true});
  if(dd)svg+='<path d="'+dd+'" fill="none" stroke="'+k[2]+'" stroke-width="1.5"'+(k[4]?' stroke-dasharray="5 3"':'')+'/>';
 });
 var step=labelStep(bw);
 rows.forEach(function(s,i){if(i%step===0)svg+='<text x="'+(padL+i*bw+bw/2)+'" y="'+(h-4)+'" text-anchor="middle">'+esc(labels[i])+'</text>'});
 return svg+'</svg>';
}
function sysChartDraw(ctx){
 var s=WCH[ctx.id];if(!s||!s.d||s.w<=0)return;
 ctx.html("legend",PKEYS.map(function(k){return'<span><i style="background:'+k[2]+'"></i>'+esc(k[1])+'</span>'}).join(""));
 // the tile sets the height: the legend wraps first (its measured height is taken off), the plot takes the rest, min 80
 var lg=ctx.body&&ctx.body.querySelector('[data-k="legend"]'),lh=lg?lg.offsetHeight+6:22;
 ctx.html("svg",sysChartSvg(s.d,s.w,Math.max(80,s.h-lh)));
}
Win.registerType("chart",{minW:260,minH:150,defaultH:270,
 mount:function(ctx){if(WCHX[ctx.id]){WCHX[ctx.id].mount(ctx);return}ctx.body.innerHTML='<div class="wc-svg" data-k="svg"></div><div class="legend wc-leg" data-k="legend"></div>'},
 update:function(ctx,d){if(WCHX[ctx.id]){WCHX[ctx.id].update(ctx,d);return}if(!d||!d.series)return;var s=WCH[ctx.id]||(WCH[ctx.id]={w:0,h:0,d:null});s.d=d;sysChartDraw(ctx)},
 resize:function(ctx,w,h){if(WCHX[ctx.id]){WCHX[ctx.id].resize(ctx,w,h);return}var s=WCH[ctx.id]||(WCH[ctx.id]={w:0,h:0,d:null});s.w=w;s.h=h;sysChartDraw(ctx)}});
/** The up servers' four cards per server, added by data (a structural change). */
var SRV_WHAT=[["rss","RSS"],["e2e","end-to-end"],["decode","decode"],["prefix","prefix cache"]];
function sysServerSync(d){
 var specs=[],rows=[],list=(d&&d.servers)||[],i,j,up=0;
 for(i=0;i<list.length;i++){
  if(list[i].up===false)continue;
  up++;
  var row=[];
  for(j=0;j<SRV_WHAT.length;j++){
   var id="system.srv:"+list[i].provider+"/"+SRV_WHAT[j][0];
   row.push(id);specs.push({id:id,type:"metric",title:list[i].provider+" "+SRV_WHAT[j][1],feeds:["system","data"],view:sysServerView});
  }
  rows.push(row);
 }
 Win.hide("system.srv:none",up>0);
 if(specs.length&&Win.addCards("sys-servers",specs,rows))Win.update("system",d);
}
/** The system feed: the static cards, then the dynamic server cards. */
function winFeedSystem(j){Win.update("system",j);sysServerSync(j)}
function sysDefaults(){
 var pw=[];
 var cards=[{id:"system",type:"group",title:"System — memory, load, temperature, power",info:SYS_INFO},
  {id:"sys-metrics",type:"group",title:"Memory, load, temperature, power"},
  {id:"sys-power",type:"group",title:"Power and load"},
  {id:"sys-servers",type:"group",title:"Local model servers"},
  {id:"system.srv:none",type:"note",title:"Local model servers",feeds:["system"],view:sysSrvNoneView,hidden:true}],st={},i,r1=[],r2=[],r3=[],r4=[];
 for(i=0;i<SYS_NAMES.length;i++){
  var id="system."+SYS_NAMES[i],t=SYS_NAMES[i]==="energy"?"energy":SYSM[SYS_NAMES[i]][0];
  cards.push({id:id,type:"metric",title:t,feeds:["system"],view:sysMetricView});
  (i<5?r1:i<10?r2:r3).push(WinT.leaf(id));
  if(SYS_ZERO.indexOf(SYS_NAMES[i])>=0)st[id]={min:1};
 }
 SYS_EXTRA.forEach(function(x){
  var id="system."+x[0],on=SYS_DEFAULT_EXTRA.indexOf(x[0])>=0;
  cards.push({id:id,type:"metric",title:x[1],info:x[2],feeds:["system"],view:sysMetricView});
  if(on)pw.push(WinT.leaf(id));else{r4.push(WinT.leaf(id));st[id]={min:1}}
 });
 cards.push({id:"system.power-chart",type:"chart",title:"Power and GPU/CPU load",info:"Same buckets as the window selected above. W on the left axis, load % on the fixed 0-100 right axis. power in = what the charger delivers to the machine; charger limit (dashed) = what the adapter can supply; battery discharge = battery power drawn while discharging (the axis starts at 0, so charging is not drawn; see the battery W card for the signed value).",feeds:["system"]});
 var eq=function(n){var a=[],k;for(k=0;k<n;k++)a.push(1/n);return a};
 return{tree:WinT.leaf("system"),stDefaults:st,cards:cards,kids:{
  "system":WinT.split("c",[WinT.leaf("sys-metrics"),WinT.leaf("sys-power")],[0.6,0.4]),
  "sys-metrics":WinT.split("c",[WinT.split("r",r1,eq(5)),WinT.split("r",r2,eq(5)),WinT.split("r",r3,eq(4)),WinT.split("r",r4,eq(r4.length))],[0.25,0.25,0.25,0.25]),
  "sys-power":pw.length?WinT.split("c",[WinT.split("r",pw,eq(pw.length)),WinT.leaf("system.power-chart")],[0.3,0.7]):WinT.leaf("system.power-chart"),
  "sys-servers":WinT.leaf("system.srv:none")}};
}
`;
