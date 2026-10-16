/**
 * cockpit-page.ts — the single static page served at /cockpit. Inline CSS,
 * inline JS, inline SVG; no build step, no dependency. The script uses no
 * template literals so this module can hold it in one template string.
 */

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
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;color:var(--dim);font-size:12px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.rings{display:flex;flex-wrap:wrap;gap:10px}.ring{text-align:center;min-width:100px}.ring .n{font-weight:600}.ring .s{color:var(--dim);font-size:11px}
svg text{fill:var(--dim);font-size:10px}
</style></head><body>
<header><h1>PAI router cockpit</h1>
<div class="tabs" id="tabs"><button data-w="1h">1 hour</button><button data-w="24h">Today</button><button data-w="7d">Week</button></div>
<span id="stamp">loading...</span></header>
<main>
<section class="card c12"><h2>Limits</h2><div class="gauges" id="limits"></div></section>
<section class="card c12"><div class="kpis" id="kpis"></div></section>
<section class="card c8"><h2>Tokens per bucket by model</h2><div id="series"></div><div class="legend" id="legend"></div></section>
<section class="card c4"><h2>Cache hit ratio per model</h2><div id="donut" class="rings"></div><div id="donutnote" class="dim"></div></section>
<section class="card c6"><h2>Cache verdict by pause (per model)</h2><div id="pause"></div>
<p class="dim">Pause = time since the previous request of the same session. A drop in hits after 5m means the cache expired between turns: a keepalive under 5m would have kept it.</p></section>
<section class="card c6"><h2>Providers: errors, retries, speed</h2><div id="providers"></div></section>
<section class="card c12"><h2>Sessions by tokens</h2><div id="sessions"></div></section>
<section class="card c6"><h2>Worker runs</h2><div id="workers"></div></section>
<section class="card c6"><h2>Tokens per day per model (14 d)</h2><div id="daily"></div><div class="legend" id="dlegend"></div></section>
</main>
<script>
(function(){
var win=localStorage.getItem("cockpitWin")||"1h",data=null,lim=null,lastOk=0,PAL=["#3b6fe0","#e0703b","#2e9e5b","#b04fd0","#d9b31c","#2bb3c0","#d64570","#7a8a99","#8fbf3f","#a0522d"];
var colors={};function colorOf(k){if(!colors[k])colors[k]=PAL[Object.keys(colors).length%PAL.length];return colors[k]}
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function fmt(n){n=n||0;if(n>=1e9)return(n/1e9).toFixed(2)+"G";if(n>=1e6)return(n/1e6).toFixed(2)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return String(Math.round(n))}
function pct(x){return(x*100).toFixed(1)+"%"}
function tot(t){return t.input+t.output+t.cacheWrite+t.cacheRead}
function dur(ms){if(ms<=0)return"now";var s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+"d "+h+"h":h?h+"h "+String(m).padStart(2,"0")+"m":m+"m "+String(s%60).padStart(2,"0")+"s"}
function ago(iso){var s=(Date.now()-Date.parse(iso))/1000;return s<90?Math.round(s)+"s":s<5400?Math.round(s/60)+"m":s<172800?Math.round(s/3600)+"h":Math.round(s/86400)+"d"}
function sev(p){return p>=90?"var(--bad)":p>=70?"var(--warn)":"var(--ok)"}

function gauge(l,w){
 var p=Math.max(0,Math.min(100,w.percent)),r=44,cx=60,cy=56,a=Math.PI*p/100;
 var x=cx-r*Math.cos(a),y=cy-r*Math.sin(a);
 var arc='<path d="M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+(cx+r)+' '+cy+'" fill="none" stroke="var(--line)" stroke-width="10" stroke-linecap="round"/>';
 if(p>0)arc+='<path d="M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+x.toFixed(1)+' '+y.toFixed(1)+'" fill="none" stroke="'+sev(p)+'" stroke-width="10" stroke-linecap="round"/>';
 return '<div class="gauge"><svg width="120" height="70" viewBox="0 0 120 70">'+arc+'<text x="60" y="54" text-anchor="middle" style="font-size:16px;font-weight:600;fill:var(--fg)">'+Math.round(w.percent)+'%</text></svg>'+
  '<div class="n">'+esc(l.provider)+' '+esc(w.name)+(w.estimated?' <span class="warn">estimated</span>':'')+'</div>'+
  '<div class="s" data-reset="'+(w.resetAt||0)+'">'+(w.resetAt?'resets in '+dur(w.resetAt-Date.now()):'reset unknown')+'</div></div>';
}
function renderLimits(){
 if(!lim)return;var h="";
 lim.limits.forEach(function(l){
  l.windows.forEach(function(w){h+=gauge(l,w)});
  if(l.kind==="local"){h+='<div class="gauge"><div class="n">'+esc(l.provider)+'</div><div class="'+(l.up?"ok":"bad")+'">'+(l.up?"up":"down")+'</div><div class="s">'+(l.rssMb?l.rssMb+" MB RSS":"")+(l.tokensPerSec?" · "+l.tokensPerSec+" tok/s":"")+'</div></div>'}
  else if(!l.windows.length)h+='<div class="gauge"><div class="n">'+esc(l.provider)+'</div><div class="dim">no reading</div><div class="s">'+esc(l.error||"")+'</div></div>';
  else if(l.error)h+='<div class="gauge dim" title="'+esc(l.error)+'"><div class="s">'+esc(l.provider)+': '+esc(l.error).slice(0,60)+'</div></div>';
 });
 $("limits").innerHTML=h||'<span class="dim">no limit sources</span>';
}
function tick(){
 var els=document.querySelectorAll("[data-reset]");
 for(var i=0;i<els.length;i++){var r=+els[i].getAttribute("data-reset");if(r)els[i].textContent="resets in "+dur(r-Date.now())}
 var st=$("stamp"),age=(Date.now()-lastOk)/1000;
 st.textContent=lastOk?(age<15?"live · ":"stale "+Math.round(age)+"s · ")+new Date(lastOk).toLocaleTimeString():"loading...";
 st.className=lastOk&&age>=15?"stale":"";
}
function stackedBars(el,labels,series,keys,w,h,tickFmt){
 var padL=44,padB=18,padT=6,W=w-padL-6,H=h-padB-padT,n=labels.length,max=1;
 var sums=series.map(function(s){var t=0;keys.forEach(function(k){t+=s[k]||0});return t});sums.forEach(function(v){if(v>max)max=v});
 var bw=W/n,svg='<svg width="100%" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet">';
 for(var g=0;g<=3;g++){var yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(w-6)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(padL-4)+'" y="'+(yy+3)+'" text-anchor="end">'+fmt(max*g/3)+'</text>'}
 series.forEach(function(s,i){var y=padT+H;keys.forEach(function(k){var v=s[k]||0;if(!v)return;var bh=H*v/max;y-=bh;svg+='<rect x="'+(padL+i*bw+1)+'" y="'+y.toFixed(1)+'" width="'+Math.max(1,bw-2).toFixed(1)+'" height="'+bh.toFixed(1)+'" fill="'+colorOf(k)+'"><title>'+esc(labels[i])+' '+esc(k)+': '+fmt(v)+'</title></rect>'});
  if(n<=30||i%Math.ceil(n/12)===0)svg+='<text x="'+(padL+i*bw+bw/2)+'" y="'+(h-4)+'" text-anchor="middle">'+esc(labels[i])+'</text>'});
 el.innerHTML=svg+'</svg>';
}
function legend(el,keys){el.innerHTML=keys.map(function(k){return'<span><i style="background:'+colorOf(k)+'"></i>'+esc(k)+'</span>'}).join("")}
function label(t,win){var d=new Date(t);return win==="7d"?d.toLocaleDateString([],{weekday:"short"}):win==="24h"?String(d.getHours()).padStart(2,"0")+"h":d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
function donut(ratio){
 var r=48,c=2*Math.PI*r,d=c*ratio;
 return'<svg width="100" height="100" viewBox="0 0 140 140"><circle cx="70" cy="70" r="'+r+'" fill="none" stroke="var(--line)" stroke-width="16"/><circle cx="70" cy="70" r="'+r+'" fill="none" stroke="'+(ratio>.8?"var(--ok)":ratio>.5?"var(--warn)":"var(--bad)")+'" stroke-width="16" stroke-dasharray="'+d.toFixed(1)+' '+c.toFixed(1)+'" transform="rotate(-90 70 70)"/><text x="70" y="76" text-anchor="middle" style="font-size:22px;font-weight:600;fill:var(--fg)">'+pct(ratio)+'</text></svg>';
}
function table(head,rows){return'<table><tr>'+head.map(function(h){return'<th>'+h+'</th>'}).join("")+'</tr>'+rows.map(function(r){return'<tr>'+r.map(function(c){return'<td>'+c+'</td>'}).join("")+'</tr>'}).join("")+'</table>'}
function cls(v,warn,bad){return v>=bad?"bad":v>=warn?"warn":""}
function render(){
 if(!data)return;var d=data,t=d.totals;
 $("kpis").innerHTML=[["requests",fmt(t.requests)],["input",fmt(t.input)],["output",fmt(t.output)],["cache read",fmt(t.cacheRead)],["cache write",fmt(t.cacheWrite)],["errors",'<span class="'+cls(t.errors/Math.max(1,t.requests),.02,.1)+'">'+t.errors+'</span>']].map(function(k){return'<div class="kpi"><b>'+k[1]+'</b><span>'+k[0]+'</span></div>'}).join("");
 var models=[];d.byModel.forEach(function(m){if(models.indexOf(m.model)<0)models.push(m.model)});
 var series=d.series.map(function(b){var o={};models.forEach(function(m){var x=b.models[m];o[m]=x?tot(x):0});return o});
 stackedBars($("series"),d.series.map(function(b){return label(b.t,d.window)}),series,models,760,220);legend($("legend"),models);
 var ms={};d.byModel.forEach(function(m){var o=ms[m.model]||(ms[m.model]={model:m.model,cacheRead:0,cacheWrite:0,input:0,requests:0});o.cacheRead+=m.cacheRead;o.cacheWrite+=m.cacheWrite;o.input+=m.input;o.requests+=m.requests});
 $("donut").innerHTML=Object.keys(ms).map(function(k){var m=ms[k],dn=m.cacheRead+m.cacheWrite+m.input;return'<div class="ring">'+donut(dn?m.cacheRead/dn:0)+'<div class="n">'+esc(m.model)+'</div><div class="s">'+m.requests+' req</div></div>'}).join("")||'<span class="dim">no data</span>';
 $("donutnote").textContent="cache_read / (read + write + fresh input), per model. Overall: "+pct(t.hitRatio);
 var ph=d.cachePause.map(function(cm){
  var cells=cm.buckets.map(function(b){if(!b.n)return'<td class="dim">-</td>';var hr=b.hit/b.n;return'<td><span class="'+(hr<.5?"bad":hr<.8?"warn":"ok")+'">'+Math.round(hr*100)+'%</span> <span class="dim">'+b.n+'</span></td>'}).join("");
  return'<tr><td>'+esc(cm.model)+'</td>'+cells+'</tr>'}).join("");
 var labs=d.cachePause.length?d.cachePause[0].buckets.map(function(b){return b.label}):[];
 $("pause").innerHTML=ph?'<table><tr><th>model (hit% n)</th>'+labs.map(function(l){return'<th>'+esc(l)+'</th>'}).join("")+'</tr>'+ph+'</table>':'<span class="dim">no data</span>';
 $("providers").innerHTML=table(["provider","req","err%","retries","avg ms","hit%","tokens"],d.byProvider.map(function(p){var e=p.errors/Math.max(1,p.requests);return[esc(p.provider),p.requests,'<span class="'+cls(e,.02,.1)+'">'+pct(e)+'</span>','<span class="'+(p.retries?"warn":"")+'">'+p.retries+'</span>',p.avgMs,pct(p.hitRatio),fmt(tot(p))]}))+
  '<p class="dim">Busts: '+(Object.keys(d.bustParts).length?Object.keys(d.bustParts).map(function(k){return esc(k)+" x"+d.bustParts[k]}).join(", "):"none")+'</p>';
 $("sessions").innerHTML=table(["session","name","models","req","tokens","fresh in","out","hit%","busts","errors","last"],d.bySession.slice(0,20).map(function(s){return[esc(s.session.slice(0,8)),esc(s.name||"-"),esc(s.models.join(", ")),s.requests,fmt(tot(s)),fmt(s.input+s.cacheWrite),fmt(s.output),'<span class="'+(s.hitRatio<.5?"bad":s.hitRatio<.8?"warn":"ok")+'">'+pct(s.hitRatio)+'</span>','<span class="'+(s.busts?"warn":"")+'">'+s.busts+'</span>',s.errors,ago(s.lastTs)]}));
 $("workers").innerHTML=d.workers.length?table(["worker","label","provider","req","tokens","verdict"],d.workers.slice(0,15).map(function(s){return[esc(s.worker),esc(s.name),esc(s.workerProvider||"-"),s.requests,fmt(tot(s)),'<span class="'+(s.verdict==="ok"?"ok":s.verdict==="failed"?"bad":"dim")+'">'+esc(s.verdict)+'</span>']})):'<span class="dim">no worker sessions in this window</span>';
 var dm=Object.keys(d.daily.models),ds=d.daily.days.map(function(t,i){var o={};dm.forEach(function(m){o[m]=d.daily.models[m][i]});return o});
 stackedBars($("daily"),d.daily.days.map(function(t){return new Date(t).toLocaleDateString([],{day:"numeric",month:"numeric"})}),ds,dm,520,200);legend($("dlegend"),dm);
}
function load(){
 fetch("/cockpit/data?window="+win,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){data=j;lastOk=Date.now();render()}).catch(function(){});
}
function loadLimits(){fetch("/cockpit/limits",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){lim=j;renderLimits()}).catch(function(){})}
function tabs(){var b=document.querySelectorAll("#tabs button");for(var i=0;i<b.length;i++){b[i].className=b[i].getAttribute("data-w")===win?"on":"";b[i].onclick=function(){win=this.getAttribute("data-w");localStorage.setItem("cockpitWin",win);tabs();load()}}}
tabs();load();loadLimits();setInterval(load,5000);setInterval(loadLimits,30000);setInterval(tick,1000);
})();
</script></body></html>
`;
