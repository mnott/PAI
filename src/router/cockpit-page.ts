/**
 * cockpit-page.ts — the single static page served at /cockpit. Inline CSS,
 * inline JS, inline SVG; no build step, no dependency. The script uses no
 * template literals so this module can hold it in one template string.
 */

import { POOL_PANEL_HTML, POOL_PANEL_JS } from "./pool-panel.js";

export const COCKPIT_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PAI router cockpit</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--dim:#6b7385;--line:#e3e6ec;--ok:#2e9e5b;--warn:#d98a1c;--bad:#d64545;--acc:#3b6fe0}
@media(prefers-color-scheme:dark){:root{--bg:#10131a;--card:#181c26;--fg:#e4e8f1;--dim:#8b93a7;--line:#2a3040;--ok:#46c47a;--warn:#e8a43a;--bad:#ef6b6b;--acc:#6b95f5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
header{display:flex;align-items:center;gap:16px;padding:12px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
h1{font-size:15px;margin:0;font-weight:600}h2{font-size:12px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600}
.tabs button{background:var(--card);color:var(--fg);border:1px solid var(--line);padding:3px 12px;cursor:pointer;font:inherit}
.tabs button:first-child{border-radius:6px 0 0 6px}.tabs button:last-child{border-radius:0 6px 6px 0}
.tabs button.on{background:var(--acc);border-color:var(--acc);color:#fff}
#stamp{margin-left:auto;color:var(--dim)}#stamp.stale{color:var(--bad)}
main{padding:16px 20px;display:grid;gap:14px;grid-template-columns:repeat(12,1fr)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0;overflow:auto}
.c12{grid-column:span 12}.c8{grid-column:span 8}.c6{grid-column:span 6}.c4{grid-column:span 4}
@media(max-width:1000px){.c8,.c6,.c4{grid-column:span 12}}
.gauges{display:flex;flex-wrap:wrap;gap:18px}.gauge{text-align:center;min-width:130px}
.gauge .n{font-weight:600}.gauge .s{color:var(--dim);font-size:12px}
table{border-collapse:collapse;width:100%}th,td{text-align:right;padding:3px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:500}th:first-child,td:first-child{text-align:left}
.bar{display:inline-block;height:8px;border-radius:3px;background:var(--ok);vertical-align:middle}
.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--ok)}.dim{color:var(--dim)}
.kpis{display:flex;gap:26px;flex-wrap:wrap}.kpi b{font-size:20px;display:block;font-weight:600}.kpi span{color:var(--dim)}
.groups{display:flex;gap:28px;flex-wrap:wrap}.grp{flex:1;min-width:260px}.grp+.grp{border-left:1px solid var(--line);padding-left:24px}.ctl{display:flex;gap:10px;align-items:center;margin-bottom:6px;flex-wrap:wrap}.ctl button,.ctl select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 10px;font:inherit;cursor:pointer}.ctl button.on{background:var(--acc);border-color:var(--acc);color:#fff}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;color:var(--dim);font-size:12px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.rings{display:flex;flex-wrap:wrap;gap:10px}.ring{text-align:center;min-width:100px}.ring .n{font-weight:600}.ring .s{color:var(--dim);font-size:11px}
.rings .solo{display:flex;align-items:center;justify-content:center;gap:16px;width:100%;flex-wrap:wrap}.bignum{font-size:26px;font-weight:600;text-align:center}.bignum span{display:block;font-size:11px;color:var(--dim);font-weight:400}
svg text{fill:var(--dim);font-size:10px}
#sessions td:first-child span[title]{display:inline-block;max-width:480px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
</style></head><body>
<header><h1>PAI router cockpit</h1>
<div class="tabs" id="tabs"><button data-w="1h">1 hour</button><button data-w="24h">Today</button><button data-w="7d">Week</button></div>
<span id="stamp">loading...</span></header>
<main>
<section class="card c12"><div class="groups"><div class="grp"><h2>Cloud</h2><div class="gauges" id="cloud"></div></div><div class="grp"><h2>Local</h2><div class="gauges" id="local"></div></div></div></section>
<section class="card c12"><h2>System — memory, load, temperature, power</h2><div class="kpis" id="sys"></div><div id="sysservers" style="margin-top:10px"></div></section>
${POOL_PANEL_HTML}
<section class="card c12"><div class="kpis" id="kpis"></div></section>
<section class="card c8"><h2>Tokens per bucket by kind</h2><div class="ctl"><span id="mode"><button data-m="weighted">weighted</button><button data-m="raw">raw</button></span><select id="msel"></select></div><div id="series"></div><div class="legend" id="legend"></div>
<h2 style="margin-top:12px">Power and GPU/CPU load, same buckets</h2><div id="power"></div><div class="legend" id="plegend"></div><p class="dim" id="wnote"></p></section>
<section class="card c4"><h2>Cache hit ratio / providers</h2><div id="donut" class="rings"></div><div id="donutnote" class="dim"></div>
<h2 id="donutlocaltitle" style="margin-top:12px;display:none">Local prefix cache (server counters)</h2><div id="donutlocal" class="rings"></div><div id="donutlocalnote" class="dim"></div>
<h2 style="margin-top:12px">Providers: errors, retries, speed</h2><div id="providers"></div></section>
<section class="card c12"><h2>Speed per model (TTFT, read, write)</h2><div id="speed"></div>
<p class="dim">TTFT = request sent to first content token. Read = input tokens / TTFT (prefill incl. cached for local models; for Anthropic input excludes cache reads). Write = output tokens / decode time, replies of 16+ tokens only. Medians (p50) unless marked.</p></section>
<section class="card c12"><h2>Cache verdict by pause (per model)</h2><div id="pause"></div>
<p class="dim">Pause = time since the previous request of the same session. A drop in hits after 5m means the cache expired between turns: a keepalive under 5m would have kept it.</p></section>
<section class="card c12"><h2>Sessions by tokens</h2><div id="sessions"></div></section>
<section class="card c6"><h2>Worker runs</h2><div id="workers"></div></section>
<section class="card c6"><h2>Tokens per day per model (14 d)</h2><div id="daily"></div><div class="legend" id="dlegend"></div></section>
</main>
<script>
(function(){
var KINDS=[["input","fresh input","#3b6fe0"],["cacheWrite","cache write","#e0703b"],["cacheRead","cache read","#2e9e5b"],["output","output","#b04fd0"]],mode=localStorage.getItem("cockpitMode")||"weighted",msel="";var win=localStorage.getItem("cockpitWin")||"1h",data=null,lim=null,lastOk=0,PAL=["#3b6fe0","#e0703b","#2e9e5b","#b04fd0","#d9b31c","#2bb3c0","#d64570","#7a8a99","#8fbf3f","#a0522d"];
var colors={};function colorOf(k){for(var i=0;i<KINDS.length;i++)if(KINDS[i][0]===k)return KINDS[i][2];if(!colors[k])colors[k]=PAL[Object.keys(colors).length%PAL.length];return colors[k]}
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function fmt(n){n=n||0;if(n>=1e9)return(n/1e9).toFixed(2)+"G";if(n>=1e6)return(n/1e6).toFixed(2)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return String(Math.round(n))}
function pct(x){return(x*100).toFixed(1)+"%"}
function tot(t){return t.input+t.output+t.cacheWrite+t.cacheRead}
function dur(ms){if(ms<=0)return"now";var s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+"d "+h+"h":h?h+"h "+String(m).padStart(2,"0")+"m":m+"m "+String(s%60).padStart(2,"0")+"s"}
function ago(iso){var s=(Date.now()-Date.parse(iso))/1000;return s<90?Math.round(s)+"s":s<5400?Math.round(s/60)+"m":s<172800?Math.round(s/3600)+"h":Math.round(s/86400)+"d"}
function sev(p){return p>=90?"var(--bad)":p>=70?"var(--warn)":"var(--ok)"}

function gauge(l,w,age){
 var p=Math.max(0,Math.min(100,w.percent)),r=44,cx=60,cy=56,a=Math.PI*p/100;
 var x=cx-r*Math.cos(a),y=cy-r*Math.sin(a);
 var arc='<path d="M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+(cx+r)+' '+cy+'" fill="none" stroke="var(--line)" stroke-width="10" stroke-linecap="round"/>';
 if(p>0)arc+='<path d="M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+x.toFixed(1)+' '+y.toFixed(1)+'" fill="none" stroke="'+sev(p)+'" stroke-width="10" stroke-linecap="round"/>';
 return '<div class="gauge"><svg width="120" height="70" viewBox="0 0 120 70">'+arc+'<text x="60" y="54" text-anchor="middle" style="font-size:16px;font-weight:600;fill:var(--fg)">'+Math.round(w.percent)+'%</text></svg>'+
  '<div class="n">'+esc(l.provider)+' '+esc(w.name)+(age?' <span class="warn" title="'+esc(l.error||"")+'">· '+esc(age)+' old</span>':'')+(w.estimated?' <span class="warn">estimated</span>':'')+'</div>'+
  '<div class="s" data-reset="'+(w.resetAt||0)+'">'+(w.resetAt?'resets in '+dur(w.resetAt-Date.now()):'reset unknown')+'</div></div>';
}
function renderLimits(){
 if(!lim)return;var c="",lo="";
 lim.limits.forEach(function(l){
  var h="",age=l.error&&/usage reading /.test(l.error)&&l.fetchedAt&&l.fetchedAt<=Date.now()?ago(new Date(l.fetchedAt).toISOString()):"";
  if(l.kind==="local"){h+='<div class="gauge"><div class="n">'+esc(l.provider)+'</div><div class="'+(l.up?"ok":"bad")+'">'+(l.up?"up":"down")+'</div><div class="s">'+(l.rssMb?l.rssMb+" MB RSS":"")+(l.tokensPerSec?" · "+l.tokensPerSec+" tok/s":"")+'</div>'+(l.served&&l.served.length?'<div class="s">'+esc(l.served[0])+'</div>':'')+'</div>';lo+=h;return}
  l.windows.forEach(function(w){h+=gauge(l,w,age)});
  if(!l.windows.length)h+='<div class="gauge"><div class="n">'+esc(l.provider)+'</div><div class="dim">no reading</div><div class="s">'+esc(l.error||"")+'</div></div>';
  else if(l.error)h+='<div class="gauge dim" title="'+esc(l.error)+'"><div class="s">'+esc(l.provider)+': '+esc(l.error)+'</div></div>';
  c+=h;
 });
 $("cloud").innerHTML=c||'<span class="dim">no cloud limit sources</span>';
 $("local").innerHTML=lo||'<span class="dim">no local providers</span>';
}
var sys=null;
/** 4th column: 0 = watts on the left axis (auto), 1 = percent on the fixed 0-100 right axis. */
var PKEYS=[["totalW","power W","#d98a1c",0],["gpu","GPU load","#3b6fe0",1],["cpu","CPU load","#2e9e5b",1]];
function gb(b,d){return b==null?"n/a":(b/1073741824).toFixed(d==null?1:d)}
/** Last good readings per metric: a stale source keeps its number on the card instead of n/a. */
var LAST={};
/** A reading the payload no longer carries: the last value stays, dimmed, with a ~age suffix. tip is pre-escaped. */
function staleCell(m,now,fmt,tip){
 var s=Math.max(0,(now-m.at)/1000),a=s<90?Math.round(s)+"s":s<3600?Math.round(s/60)+"m":Math.round(s/3600)+"h";
 return'<span class="dim"'+(tip?' title="'+tip+'"':'')+'>'+fmt(m.v)+' <span class="warn">~'+a+'</span></span>'
}
function renderSystem(){
 if(!sys)return;var c=sys.current||{};
 var tip=(sys.unavailable&&sys.unavailable.all)?sys.unavailable.all:((c.notes||[]).join("; ")||("source: "+(c.source||"none")));
 function na(v){return v==null?'<span class="dim" title="'+esc(tip)+'">n/a</span>':v}
 /** Fresh number, or the last good one when the payload dropped it — the card never hides the value. */
 function val(key,fmt){
  var v=c[key];
  if(v!=null){LAST[key]={v:v,at:Date.now()};return fmt(v)}
  var m=LAST[key];return m?staleCell(m,Date.now(),fmt,esc(tip)):na(null)
 }
 function pctf(v){return Math.round(v)+"%"}
 function w1(v){return v.toFixed(1)}
 var slowAge=sys.slowAgeS; // mactop probe (gpu/temp/power) rides the 1-min ring; say how old it is
 function tag(){return slowAge==null?"":" · "+(slowAge<90?"probe "+slowAge+"s":"cached "+(slowAge<3600?Math.round(slowAge/60)+" min":Math.round(slowAge/3600)+" h"))}
 var freq=c.gpuFreqMhz; // GPU clock for the load sublabel, remembered like the other probe values
 if(freq==null&&LAST.gpuFreqMhz)freq=LAST.gpuFreqMhz.v;else if(freq!=null)LAST.gpuFreqMhz={v:freq,at:Date.now()};
 var wh=(sys.series&&sys.series.wh&&sys.series.wh[win])||0,cov=(sys.series&&sys.series.coveredMin&&sys.series.coveredMin[win])||0;
 var kpis=[
  ["memory",c.memUsed!=null?gb(c.memUsed):na(null),"of "+na(c.memTotal!=null?gb(c.memTotal):null)+" · pressure "+(c.pressureLevel!=null?(100-c.pressureLevel)+"%":na(null))],
  ["swap",c.swapUsed!=null?gb(c.swapUsed):na(null),"of "+na(c.swapTotal!=null?gb(c.swapTotal):null)],
  ["wired",c.wired!=null?gb(c.wired):na(null),"vm_stat"],
  ["compressed",c.compressed!=null?gb(c.compressed):na(null),"vm_stat"],
  ["CPU load",val("cpu",pctf),"all clusters"],
  ["GPU load",val("gpu",pctf),(freq?(freq/1000).toFixed(1)+" GHz":"IOReport")+tag()],
  ["ANE load",val("ane",pctf),"neural engine"+tag()],
  ["SoC temp",val("socTemp",function(v){return v.toFixed(1)+" °C"}),"IOReport"+tag()],
  ["CPU W",val("cpuW",w1),"CPU rail"+tag()],
  ["GPU W",val("gpuW",w1),"GPU rail"+tag()],
  ["ANE W",val("aneW",w1),"neural engine"+tag()],
  ["system W",val("systemW",w1),"system rail"+tag()],
  ["power",val("totalW",function(v){return w1(v)+" W"}),"SoC total"+tag()],
  ["energy "+win,wh+" Wh",cov+" min of 1-min samples"]
 ];
 $("sys").innerHTML=kpis.map(function(k){return'<div class="kpi"><b>'+k[1]+'</b><span>'+esc(k[0])+'</span><span style="display:block;color:var(--dim)">'+k[2]+'</span></div>'}).join("");
 var allSrv=sys.servers||[];
 var srv=allSrv.filter(function(s){return s.up!==false});
 function dec(p){var r=((data&&data.speed)||[]).filter(function(x){return x.provider===p&&(x.h1.writeTps!=null||x.h24.writeTps!=null)})[0];if(!r)return'<span class="dim">-</span>';return fmt(r.h1.writeTps!=null?r.h1.writeTps:r.h24.writeTps)}
$("sysservers").innerHTML=srv.length?table(["local server","status","RSS","end-to-end tok/s","decode tok/s","prefix cache"],srv.map(function(s){return[esc(s.provider),'<span class="'+(s.up?"ok":"bad")+'">'+(s.up?"up":"down")+'</span>',s.rssMb!=null?s.rssMb+" MB":'<span class="dim">n/a</span>',s.tokensPerSec!=null?s.tokensPerSec:'<span class="dim">-</span>',dec(s.provider),s.prefixCache?pct(s.prefixCache.hitRate)+" ("+s.prefixCache.hits+"/"+(s.prefixCache.hits+s.prefixCache.misses)+")":'<span class="dim">not reported</span>']})):'<span class="dim">'+(allSrv.length?"all local model servers down":"no local model servers configured")+'</span>';
 renderDonuts();
}
function trimEmpty(labels,rows,totalOf){
 var a=0,b=rows.length-1;
 while(a<=b&&!totalOf(rows[a]))a++;
 while(b>=a&&!totalOf(rows[b]))b--;
 return a>b?null:{labels:labels.slice(a,b+1),rows:rows.slice(a,b+1)}
}
function emptyChart(w,h){
 var padL=44,padB=18,padT=6,W=w-padL-6,H=h-padB-padT,svg='<svg width="100%" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet">';
 for(var g=0;g<=3;g++){var yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(w-6)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/>'}
 svg+='<text x="'+(padL+W/2)+'" y="'+(padT+H/2+3)+'" text-anchor="middle">no data in this window</text>';
 return svg+'</svg>';
}
function lineChart(el,labels,series,keys,w,h){
 var tr=trimEmpty(labels,series,function(s){var t=0;keys.forEach(function(k){t+=s[k[0]]||0});return t});
 if(!tr){el.innerHTML=emptyChart(w,h);return}
 labels=tr.labels;series=tr.rows;
 var padL=44,padR=34,padB=18,padT=6,W=w-padL-padR,H=h-padB-padT,n=labels.length,bw=W/n;
 var leftMax=1,hasR=false; // key[3]: 1 = percent, fixed 0-100 right axis; others share the auto left axis
 keys.forEach(function(k){if(k[3])hasR=true;else series.forEach(function(s){if((s[k[0]]||0)>leftMax)leftMax=s[k[0]]})});
 var PCT=["0","33","66","100"],svg='<svg width="100%" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet">';
 for(var g=0;g<=3;g++){var yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(w-padR)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(padL-4)+'" y="'+(yy+3)+'" text-anchor="end">'+(leftMax*g/3).toFixed(1)+' W</text>'+
  (hasR?'<text x="'+(w-2)+'" y="'+(yy+3)+'" text-anchor="end">'+PCT[g]+'%</text>':'')}
 keys.forEach(function(k){
  var scale=k[3]?100:leftMax,d="",pen=false;
  series.forEach(function(s,i){var v=s[k[0]];if(v==null){pen=false;return}
   var x=padL+i*bw+bw/2,y=padT+H-(v/scale)*H;d+=(pen?"L":"M")+x.toFixed(1)+' '+y.toFixed(1);pen=true});
  if(d)svg+='<path d="'+d+'" fill="none" stroke="'+k[2]+'" stroke-width="1.5"/>';
 });
 series.forEach(function(s,i){if(n<=30||i%Math.ceil(n/12)===0)svg+='<text x="'+(padL+i*bw+bw/2)+'" y="'+(h-4)+'" text-anchor="middle">'+esc(labels[i])+'</text>'});
 el.innerHTML=svg+'</svg>';
}
function renderPower(){
 if(!sys||!sys.series)return;
 var ss=sys.series.series;
 lineChart($("power"),ss.map(function(b){return label(b.t,sys.window)}),ss,PKEYS,760,150);
 $("plegend").innerHTML=PKEYS.map(function(k){return'<span><i style="background:'+k[2]+'"></i>'+esc(k[1])+'</span>'}).join("")+'<span>(W on the left axis, load % on the fixed 0-100 right axis, buckets as above)</span>';
}
function tick(){
 var els=document.querySelectorAll("[data-reset]");
 for(var i=0;i<els.length;i++){var r=+els[i].getAttribute("data-reset");if(r)els[i].textContent="resets in "+dur(r-Date.now())}
 var st=$("stamp"),age=(Date.now()-lastOk)/1000;
 st.textContent=lastOk?(age<15?"live · ":"stale "+Math.round(age)+"s · ")+new Date(lastOk).toLocaleTimeString():"loading...";
 st.className=lastOk&&age>=15?"stale":"";
}
/** Columns for the bar charts: runs of zero-total buckets collapse into one 0.4-width spacer. */
function gapCols(totals){var cols=[],i=0;while(i<totals.length){if(totals[i]>0){cols.push({b:i,g:0});i++}else{var j=i;while(j<totals.length&&!totals[j])j++;cols.push({b:i,g:j-i});i=j}}return cols}
function gapLayout(totals,w,padL){
 var cols=gapCols(totals),units=0;cols.forEach(function(c){units+=c.g?0.4:1});
 var rn=0;cols.forEach(function(c){if(!c.g)rn++});
 return{cols:cols,bw:(w-padL-6)/units,step:rn>30?Math.ceil(rn/12):0,compressed:cols.some(function(c){return c.g>0})}
}
function gapMark(x,top,bot){return'<line x1="'+x.toFixed(1)+'" x2="'+x.toFixed(1)+'" y1="'+top+'" y2="'+bot+'" stroke="var(--line)" stroke-dasharray="2 3"/>'}
function stackedBars(el,labels,series,keys,w,h,tickFmt){
 var padL=44,padB=18,padT=6,H=h-padB-padT,max=1;
 var sums=series.map(function(s){var t=0;keys.forEach(function(k){t+=s[k]||0});return t});sums.forEach(function(v){if(v>max)max=v});
 var L=gapLayout(sums,w,padL),svg='<svg width="100%" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet">';
 for(var g=0;g<=3;g++){var yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(w-6)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(padL-4)+'" y="'+(yy+3)+'" text-anchor="end">'+fmt(max*g/3)+'</text>'}
 var x=padL,ri=0;
 L.cols.forEach(function(c){
  var cw=L.bw*(c.g?0.4:1);
  if(c.g)svg+=gapMark(x+cw/2,padT,padT,padT+H);
  else{var s=series[c.b],y=padT+H;
   keys.forEach(function(k){var v=s[k]||0;if(!v)return;var bh=H*v/max;y-=bh;svg+='<rect x="'+(x+1).toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+Math.max(1,cw-2).toFixed(1)+'" height="'+bh.toFixed(1)+'" fill="'+colorOf(k)+'"><title>'+esc(labels[c.b])+' '+esc(k)+': '+fmt(v)+'</title></rect>'});
   if(!L.step||ri%L.step===0)svg+='<text x="'+(x+cw/2).toFixed(1)+'" y="'+(h-4)+'" text-anchor="middle">'+esc(labels[c.b])+'</text>';
   ri++}
  x+=cw;
 });
 el.innerHTML=svg+'</svg>';
 return L.compressed;
}
function twoToneModelBars(el,labels,buckets,models,w,h){
 var padL=44,padB=18,padT=6,W=w-padL-6,H=h-padB-padT,mc=models.length,max=1;
 models.forEach(function(m){colorOf(m)});
 var totals=buckets.map(function(arr){var t=0;arr.forEach(function(s){t+=s.total});return t});totals.forEach(function(v){if(v>max)max=v});
 var L=gapLayout(totals,w,padL),mwid=mc?Math.max(3,L.bw/mc):L.bw,svg='<svg width="100%" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet">';
 for(var g=0;g<=3;g++){var yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(w-6)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(padL-4)+'" y="'+(yy+3)+'" text-anchor="end">'+fmt(max*g/3)+'</text>'}
 var x=padL,ri=0;
 L.cols.forEach(function(c){
  var cw=L.bw*(c.g?0.4:1);
  if(c.g)svg+=gapMark(x+cw/2,padT,padT,padT+H);
  else{var arr=buckets[c.b];
   arr.forEach(function(s){
    var c2=colorOf(s.model),fresh=s.total-s.cacheRead,bx=(x+models.indexOf(s.model)*mwid+1).toFixed(1),bwid=Math.max(1,mwid-2).toFixed(1);
    var tip=esc(s.model)+" · "+esc(labels[c.b])+": total "+fmt(s.total)+" · non-cached "+fmt(fresh)+" · cached "+fmt(s.cacheRead)+" — "+KINDS.map(function(k){return k[1]+" "+fmt(s[k[0]])}).join(", ")+" · "+s.requests+" req";
    svg+='<rect x="'+bx+'" y="'+(padT+H-H*s.total/max).toFixed(1)+'" width="'+bwid+'" height="'+(H*s.total/max).toFixed(1)+'" fill="'+c2+'" fill-opacity=".25"><title>'+tip+'</title></rect>';
    if(fresh>0)svg+='<rect x="'+bx+'" y="'+(padT+H-H*fresh/max).toFixed(1)+'" width="'+bwid+'" height="'+(H*fresh/max).toFixed(1)+'" fill="'+c2+'"><title>'+tip+'</title></rect>';
   });
   if(!L.step||ri%L.step===0)svg+='<text x="'+(x+cw/2).toFixed(1)+'" y="'+(h-4)+'" text-anchor="middle">'+esc(labels[c.b])+'</text>';
   ri++}
  x+=cw;
 });
 el.innerHTML=svg+'</svg>';
 return L.compressed;
}
function legend(el,keys){el.innerHTML=keys.map(function(k){return'<span><i style="background:'+colorOf(k)+'"></i>'+esc(k)+'</span>'}).join("")}
function label(t,win){var d=new Date(t);return win==="7d"?d.toLocaleDateString([],{weekday:"short"}):win==="24h"?String(d.getHours()).padStart(2,"0")+"h":d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
function donut(ratio,sz){
 var r=48,c=2*Math.PI*r,d=c*ratio;sz=sz||100;
 return'<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 140 140"><circle cx="70" cy="70" r="'+r+'" fill="none" stroke="var(--line)" stroke-width="16"/><circle cx="70" cy="70" r="'+r+'" fill="none" stroke="'+(ratio>.8?"var(--ok)":ratio>.5?"var(--warn)":"var(--bad)")+'" stroke-width="16" stroke-dasharray="'+d.toFixed(1)+' '+c.toFixed(1)+'" transform="rotate(-90 70 70)"/><text x="70" y="'+(sz>120?79:76)+'" text-anchor="middle" style="font-size:'+(sz>120?28:22)+'px;font-weight:600;fill:var(--fg)">'+pct(ratio)+'</text></svg>';
}
function table(head,rows){return'<table><tr>'+head.map(function(h){return'<th>'+h+'</th>'}).join("")+'</tr>'+rows.map(function(r){return'<tr>'+r.map(function(c){return'<td>'+c+'</td>'}).join("")+'</tr>'}).join("")+'</table>'}
/** Cache rings for the c4 card: cloud per model, then per model served by a local server (mapping from /cockpit/system). */
function reuse(prov,pc){var tot=(data.promptByProvider||{})[prov];if(!tot||tot<pc.tokensSaved)return'<div class="s dim">prompt tokens served from cache: n/a (no prompt total)</div>';return'<div class="s">prompt tokens served from cache: '+pct(pc.tokensSaved/tot)+' ('+fmt(pc.tokensSaved)+' of '+fmt(tot)+', total from the router usage log)</div>'}
function renderSpeed(){
 var sp=(data&&data.speed)||[];
 function c(st,k,u){return st[k]==null?'<span class="dim">-</span>':fmt(st[k])+u}
 $("speed").innerHTML=sp.length?table(["provider","model","req 1h / 24h","TTFT p50 1h","p90 1h","TTFT p50 24h","p90 24h","read tok/s 1h","24h","write tok/s 1h","24h"],sp.map(function(r){return[esc(r.provider),esc(r.model),r.h1.requests+" / "+r.h24.requests,c(r.h1,"ttftP50"," ms"),c(r.h1,"ttftP90"," ms"),c(r.h24,"ttftP50"," ms"),c(r.h24,"ttftP90"," ms"),c(r.h1,"readTps",""),c(r.h24,"readTps",""),c(r.h1,"writeTps",""),c(r.h24,"writeTps","")]})):'<span class="dim">no timed requests yet (timing is recorded for streamed replies since the router restart)</span>';
}
function renderDonuts(){ renderSpeed();
 if(!data)return;var d=data,t=d.totals,ms={};
 d.byModel.forEach(function(m){var k=m.provider+"\u0000"+m.model,o=ms[k]||(ms[k]={provider:m.provider,model:m.model,cacheRead:0,cacheWrite:0,input:0,requests:0});o.cacheRead+=m.cacheRead;o.cacheWrite+=m.cacheWrite;o.input+=m.input;o.requests+=m.requests});
 var mk=Object.keys(ms),dh="";
 if(mk.length===1){var m=ms[mk[0]],dn=m.cacheRead+m.cacheWrite+m.input;
  dh='<div class="solo">'+(m.cacheRead+m.cacheWrite?donut(dn?m.cacheRead/dn:0,170)+'<div class="bignum">'+pct(t.hitRatio)+'<span>overall hit ratio</span><span>'+esc(m.provider)+' · '+esc(m.model)+' · '+m.requests+' req</span></div>':'<div class="bignum dim">not reported<span>cache hit ratio</span><span>'+esc(m.provider)+' · '+esc(m.model)+' · '+m.requests+' req</span></div>')+'</div>';
 }else dh=mk.map(function(k){var m=ms[k],dn=m.cacheRead+m.cacheWrite+m.input;return'<div class="ring">'+(m.cacheRead+m.cacheWrite?donut(dn?m.cacheRead/dn:0):'<div class="bignum dim">not reported</div>')+'<div class="n">'+esc(m.provider)+'</div><div class="s">'+esc(m.model)+' · '+m.requests+' req</div></div>'}).join("");
 $("donut").innerHTML=dh||'<span class="dim">no data</span>';
 var note="cache_read / (read + write + fresh input), per provider / model. Overall: "+pct(t.hitRatio);
 var sk=d.sessionSplit;
 if(sk)note+=". continuous "+pct(sk.continuous.hitRatio)+" ("+sk.continuous.sessions+" sess, "+sk.continuous.requests+" req) · one-shot "+pct(sk.oneShot.hitRatio)+" ("+sk.oneShot.sessions+" sess, "+sk.oneShot.requests+" req)";
 if(d.pool&&d.pool.tasks)note+=". pool: "+d.pool.tasks+" task(s), "+fmt(d.pool.tokensCarried)+" tokens carried";
 $("donutnote").textContent=note;
 var loc=(sys&&sys.servers||[]).filter(function(s){return s.up!==false});
 var lh="";
 loc.forEach(function(s){var pc=s.prefixCache,r=ms[s.provider+"\u0000"+(s.served||[])[0]];
  if(pc)lh+='<div class="ring">'+donut(pc.hitRate)+'<div class="n">'+esc(s.provider)+'</div><div class="s">'+pc.hits+' hit / '+pc.misses+' miss · '+fmt(pc.tokensSaved)+' tokens saved</div><div class="s">requests with any cache hit: '+pct(pc.hitRate)+'</div>'+reuse(s.provider,pc)+'</div>';
  else lh+='<div class="ring"><div class="n">'+esc(s.provider)+'</div><div class="s dim">prefix cache: not reported by this server'+(r&&r.requests?' · '+r.requests+' req':'')+'</div></div>'});
 $("donutlocaltitle").style.display=loc.length?"":"none";
 $("donutlocal").innerHTML=lh||'<span class="dim">no local model servers running</span>';
 $("donutlocalnote").textContent=loc.length?"Local prefix cache, as each server counts it since it started: hits / (hits + misses). Free to use; a hit skips re-computing the cached part of the prompt (latency), it does not save money.":"";
}
function cls(v,warn,bad){return v>=bad?"bad":v>=warn?"warn":""}
function render(){
 if(!data)return;var d=data,t=d.totals;
 $("kpis").innerHTML=[["requests",fmt(t.requests)],["input",fmt(t.input)],["output",fmt(t.output)],["cache read",fmt(t.cacheRead)],["cache write",fmt(t.cacheWrite)],["errors",'<span class="'+cls(t.errors/Math.max(1,t.requests),.02,.1)+'">'+t.errors+'</span>']].map(function(k){return'<div class="kpi"><b>'+k[1]+'</b><span>'+k[0]+'</span></div>'}).join("");
 var models=[];d.byModel.forEach(function(m){if(models.indexOf(m.model)<0)models.push(m.model)});
 var sel=$("msel");if(msel&&models.indexOf(msel)<0)msel="";
 sel.innerHTML='<option value="">all models</option>'+models.map(function(m){return'<option'+(m===msel?' selected':'')+'>'+esc(m)+'</option>'}).join("");
 sel.onchange=function(){msel=this.value;render()};
 var W=d.weights||{input:1,cacheWrite:1.25,cacheRead:.1,output:5},wt=mode==="weighted";
 var series=d.series.map(function(b){var o={};KINDS.forEach(function(k){o[k[0]]=0});Object.keys(b.models).forEach(function(m){if(msel&&m!==msel)return;KINDS.forEach(function(k){o[k[0]]+=(b.models[m][k[0]]||0)*(wt?W[k[0]]:1)})});return o});
 var buckets=d.series.map(function(b){var arr=[];models.forEach(function(m){var v=b.models[m];if(!v)return;var o={model:m,requests:v.requests||0};KINDS.forEach(function(k){o[k[0]]=(v[k[0]]||0)*(wt?W[k[0]]:1)});o.total=tot(o);if(o.total>0)arr.push(o)});return arr});
 var labs=d.series.map(function(b){return label(b.t,d.window)});
 var gap=msel?stackedBars($("series"),labs,series,KINDS.map(function(k){return k[0]}),760,220):twoToneModelBars($("series"),labs,buckets,models,760,220);
 $("legend").innerHTML=KINDS.map(function(k){return'<span><i style="background:'+k[2]+'"></i>'+k[1]+(wt?' x'+W[k[0]]:'')+'</span>'}).join("")+(msel?"":'<span><i style="background:'+colorOf("input")+';opacity:.25"></i>total (light)</span><span><i style="background:'+colorOf("input")+'"></i>non-cached (solid)</span>'+models.map(function(m){return'<span><i style="background:'+colorOf(m)+'"></i>'+esc(m)+'</span>'}).join(""))+(gap?'<span class="dim">idle buckets compressed — the x axis is not time-linear</span>':"");
 $("wnote").textContent=wt?"Weighted: tokens times Anthropic price ratios relative to fresh input (cache read "+W.cacheRead+", cache write "+W.cacheWrite+", output "+W.output+"). The same ratios are applied to every other provider, whatever its real prices.":"Raw: token counts as reported.";
 var mb=document.querySelectorAll("#mode button");for(var i=0;i<mb.length;i++){mb[i].className=mb[i].getAttribute("data-m")===mode?"on":"";mb[i].onclick=function(){mode=this.getAttribute("data-m");localStorage.setItem("cockpitMode",mode);render()}}
 renderDonuts();
 var ph=d.cachePause.map(function(cm){
  var cells=cm.buckets.map(function(b){if(!b.n)return'<td class="dim">-</td>';var hr=b.hit/b.n;return'<td><span class="'+(hr<.5?"bad":hr<.8?"warn":"ok")+'">'+Math.round(hr*100)+'%</span> <span class="dim">'+b.n+'</span></td>'}).join("");
  return'<tr><td>'+esc(cm.model)+'</td>'+cells+'</tr>'}).join("");
 var labs=d.cachePause.length?d.cachePause[0].buckets.map(function(b){return b.label}):[];
 $("pause").innerHTML=ph?'<table><tr><th>model (hit% n)</th>'+labs.map(function(l){return'<th>'+esc(l)+'</th>'}).join("")+'</tr>'+ph+'</table>':'<span class="dim">no data</span>';
 $("providers").innerHTML=table(["provider","req","err%","retries","avg ms","hit%","tokens"],d.byProvider.map(function(p){var e=p.errors/Math.max(1,p.requests);return[esc(p.provider),p.requests,'<span class="'+cls(e,.02,.1)+'">'+pct(e)+'</span>','<span class="'+(p.retries?"warn":"")+'">'+p.retries+'</span>',p.avgMs,pct(p.hitRatio),fmt(tot(p))]}))+
  '<p class="dim">Busts: '+(Object.keys(d.bustParts).length?Object.keys(d.bustParts).map(function(k){return esc(k)+" x"+d.bustParts[k]}).join(", "):"none")+'</p>';
 $("sessions").innerHTML=table(["session","models","req","tokens","fresh in","out","hit%","busts","errors","last"],d.bySession.slice(0,20).map(function(s){var nm=s.name?esc(s.name)+' <span class="dim">· '+esc(s.session.slice(0,8))+'</span>':esc(s.session.slice(0,8));var v=s.worker?' <span class="'+(s.verdict==="ok"?"ok":s.verdict==="failed"?"bad":"dim")+'" title="worker '+esc(s.worker||"")+'">'+esc(s.verdict||"worker")+'</span>':'';return['<span title="'+esc(s.session)+'">'+nm+v+'</span>',esc(s.models.join(", ")),s.requests,fmt(tot(s)),fmt(s.input+s.cacheWrite),fmt(s.output),'<span class="'+(s.hitRatio<.5?"bad":s.hitRatio<.8?"warn":"ok")+'">'+pct(s.hitRatio)+'</span>','<span class="'+(s.busts?"warn":"")+'">'+s.busts+'</span>',s.errors,ago(s.lastTs)]}));
 $("workers").innerHTML=d.workers.length?table(["worker","label","provider","req","tokens","verdict"],d.workers.slice(0,15).map(function(s){return[esc(s.worker),esc(s.name||"-"),esc(s.workerProvider||"-"),s.requests,fmt(tot(s)),'<span class="'+(s.verdict==="ok"?"ok":s.verdict==="failed"?"bad":"dim")+'">'+esc(s.verdict||"worker")+'</span>']})):'<span class="dim">no worker sessions in this window</span>';
 var dm=Object.keys(d.daily.models),ds=d.daily.days.map(function(t,i){var o={};dm.forEach(function(m){o[m]=d.daily.models[m][i]});return o});
 var dgap=stackedBars($("daily"),d.daily.days.map(function(t){return new Date(t).toLocaleDateString([],{day:"numeric",month:"numeric"})}),ds,dm,520,200);
 legend($("dlegend"),dm);if(dgap)$("dlegend").innerHTML+='<span class="dim">idle buckets compressed — the x axis is not time-linear</span>';
}
function load(){
 fetch("/cockpit/data?window="+win,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){data=j;lastOk=Date.now();render()}).catch(function(){});
}
function loadSystem(){fetch("/cockpit/system?window="+win,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){sys=j;renderSystem();renderPower();renderDonuts()}).catch(function(){})}
${POOL_PANEL_JS}
function loadLimits(){fetch("/cockpit/limits",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){lim=j;renderLimits()}).catch(function(){})}
function tabs(){var b=document.querySelectorAll("#tabs button");for(var i=0;i<b.length;i++){b[i].className=b[i].getAttribute("data-w")===win?"on":"";b[i].onclick=function(){win=this.getAttribute("data-w");localStorage.setItem("cockpitWin",win);tabs();load();loadSystem()}}}
tabs();load();loadSystem();loadLimits();loadPool();setInterval(function(){load();loadSystem()},5000);setInterval(loadLimits,30000);setInterval(loadPool,15000);setInterval(tick,1000);
})();
</script></body></html>
`;
