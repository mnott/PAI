/**
 * cockpit-page.ts — the single static page served at /cockpit. Inline CSS,
 * inline JS, inline SVG; no build step, no dependency. The script uses no
 * template literals so this module can hold it in one template string.
 */

import { POOL_PANEL_HTML, POOL_PANEL_JS } from "./pool-panel.js";

/** Favicon: a router fanning one request out to three tiers. Inline data URI —
 *  no extra file, no extra route; encodeURIComponent keeps it safe in Safari,
 *  Chrome and Firefox. */
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#3b6fe0"/><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"><path d="M8 32h16"/><path d="M24 32 46 14"/><path d="M24 32h22"/><path d="M24 32 46 50"/></g><g fill="#fff"><circle cx="50" cy="14" r="4"/><circle cx="50" cy="32" r="4"/><circle cx="50" cy="50" r="4"/></g></svg>';
export const COCKPIT_FAVICON_SVG = FAVICON_SVG;
export const COCKPIT_FAVICON_DATA_URI = "data:image/svg+xml," + encodeURIComponent(FAVICON_SVG);

const FULL_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PAI router cockpit</title>
<link rel="icon" type="image/svg+xml" href="${COCKPIT_FAVICON_DATA_URI}">
<meta name="theme-color" content="#3b6fe0">
<script>
// the theme before the first paint: the saved choice, else the system's
try{var T=localStorage.getItem("pai.cockpit.theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=T}catch(e){}
</script>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--dim:#6b7385;--line:#e3e6ec;--ok:#2e9e5b;--warn:#d98a1c;--bad:#d64545;--acc:#3b6fe0}
:root[data-theme=dark]{--bg:#10131a;--card:#181c26;--fg:#e4e8f1;--dim:#8b93a7;--line:#2a3040;--ok:#46c47a;--warn:#e8a43a;--bad:#ef6b6b;--acc:#6b95f5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
header{flex-wrap:wrap;display:flex;align-items:center;gap:16px;padding:8px 14px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
h1{font-size:15px;margin:0;font-weight:600}h2{font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600}
.card.folded>div{display:none}.fold{background:none;border:0;padding:0 4px;color:var(--dim);cursor:pointer;font:inherit;line-height:1}.fold:hover{color:var(--acc)}.fold .chev{display:inline-block;width:12px}
.tabs button{background:var(--card);color:var(--fg);border:1px solid var(--line);padding:3px 12px;cursor:pointer;font:inherit}
.tabs button:first-child{border-radius:6px 0 0 6px}.tabs button:last-child{border-radius:0 6px 6px 0}
.tabs button.on{background:var(--acc);border-color:var(--acc);color:#fff}
#stamp{margin-left:auto;color:var(--dim)}#stamp.stale{color:var(--bad)}
#theme{background:none;border:0;padding:2px;color:var(--dim);cursor:pointer;line-height:0;border-radius:50%}#theme:hover{color:var(--acc)}
:root[data-theme=dark] .ic-moon{display:none}:root:not([data-theme=dark]) .ic-sun{display:none}
main{padding:10px 14px;display:grid;gap:10px;grid-template-columns:repeat(12,minmax(0,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0;overflow-wrap:anywhere}.tw{overflow-x:auto}
.gauge .s{overflow-wrap:anywhere}
.c12{grid-column:span 12}.c8{grid-column:span 8}.c6{grid-column:span 6}.c4{grid-column:span 4}
@media(max-width:1000px){.c8,.c6,.c4{grid-column:span 12}}
.gauges{display:flex;flex-wrap:wrap;gap:10px 14px;min-width:0}.gauge{text-align:center;min-width:0;flex:1 1 110px;max-width:min(120px,100%);overflow:hidden}.gauge .n,.gauge .s{overflow-wrap:anywhere}
.gauge svg{display:block;width:100%;height:auto}
.gauge .n{font-weight:600}.gauge .s{color:var(--dim);font-size:12px}
table{border-collapse:collapse;width:100%}th,td{text-align:right;padding:2px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:500}th:first-child,td:first-child{text-align:left}
.bar{display:inline-block;height:8px;border-radius:3px;background:var(--ok);vertical-align:middle}
.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--ok)}.dim{color:var(--dim)}
.kpis{display:flex;gap:8px 20px;flex-wrap:wrap}.kpi b{font-size:20px;display:block;font-weight:600}.kpi span{color:var(--dim)}
.groups{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;min-width:0}.grp{min-width:0}.grp-cloud{flex:1 1 0}.grp-local{flex:0 1 auto;min-width:min(200px,100%);max-width:34%}.grp-local .gauges{flex-wrap:nowrap;flex-direction:column;align-items:flex-start}.grp+.grp{border-left:1px solid var(--line);padding-left:24px}@media(max-width:1000px){.grp-local{max-width:none;width:auto;flex:1 1 100%}.grp-local .gauges{flex-direction:row;flex-wrap:wrap}.grp+.grp{border-left:0;padding-left:0}}.chips.lowmodels{margin-top:6px}.ctl{display:flex;gap:10px;align-items:center;margin-bottom:6px;flex-wrap:wrap}.ctl button,.ctl select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 10px;font:inherit;cursor:pointer}.ctl button.on{background:var(--acc);border-color:var(--acc);color:#fff}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;color:var(--dim);font-size:12px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.rings{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:6px}.ring{text-align:center;min-width:0}.ring .n,.ring .s{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ring .n{font-weight:600}.ring .s{color:var(--dim);font-size:11px}.ring.low{opacity:.45}.rings h4{grid-column:1/-1;margin:0;font-size:11px;font-weight:400;color:var(--dim)}
.rings .solo{grid-column:1/-1;display:flex;align-items:center;justify-content:center;gap:16px;width:100%;flex-wrap:wrap}.bignum{font-size:26px;font-weight:600;text-align:center}.bignum span{display:block;font-size:11px;color:var(--dim);font-weight:400}
svg text{fill:var(--dim);font-size:10px}
.tip{position:relative;display:inline-block;margin-left:5px;width:14px;height:14px;line-height:14px;text-align:center;font:11px/14px inherit;font-style:normal;text-transform:none;letter-spacing:0;color:var(--dim);cursor:help;border-radius:50%;vertical-align:middle}
.tip:hover,.tip:focus{color:var(--acc);outline:none}
.tip::after{content:attr(data-tip);display:none;position:absolute;z-index:5;top:18px;left:-6px;width:max-content;max-width:min(340px,72vw);padding:6px 9px;background:var(--fg);color:var(--bg);border-radius:6px;font-size:12px;font-weight:400;line-height:1.4;white-space:pre-line;text-align:left;text-transform:none;letter-spacing:0;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.tip:hover::after,.tip:focus::after{display:block}
.downs{width:100%;color:var(--dim)}.downs summary{cursor:pointer}.downs .chip{margin:2px 2px 0 0}.chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}.chip{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:0 8px;font-size:12px;white-space:nowrap}.chip b{font-weight:600}.grip{cursor:grab;color:var(--dim)}tr.qrow{cursor:grab}
#sessions td:first-child span[title]{display:inline-block;max-width:480px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.mt{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%;overflow:hidden}
.mt-label{display:flex;align-items:center;gap:6px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}
.mt-values{display:flex;justify-content:space-between;gap:10px}.mt-values>div{display:flex;flex-direction:column;gap:2px;min-width:0}.mt-sec{text-align:right}
.mt-values{flex-wrap:nowrap}
.mt-value{font-size:clamp(18px,2.2vw,26px);font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums;white-space:nowrap}.mt-value small{font-size:12px;font-weight:500;color:var(--dim);margin-left:4px}
.mt-sub{font-size:11px;color:var(--dim);min-height:1em;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-fill{display:flex;align-items:center;gap:6px;min-width:0}.mt-bar{flex:0 0 40%;height:4px;border-radius:2px;background:var(--line);overflow:hidden}.mt-bar i{display:block;height:100%;background:var(--acc)}.mt-fill .mt-sub{flex:1 1 auto;min-width:0}
.mt-spark{display:block;width:100%;max-width:100%;height:32px;margin-top:auto;overflow:visible;color:var(--acc)}.mt-spark .mt-alt{color:var(--warn);stroke:var(--warn)}.mt-spark .mt-warn{stroke:var(--warn)}.mt-spark .mt-ok{stroke:var(--ok)}.mt-spark .mt-bad{stroke:var(--bad)}
.rt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));gap:8px;min-width:0;align-items:stretch}
.rt-card{container-type:inline-size;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%;overflow:hidden}
.rt-head{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:nowrap}
.rt-head b{font-size:14px;font-weight:600;min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-head .badge{flex:0 0 auto}
.rt-sub{color:var(--dim);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-dot{width:9px;height:9px;border-radius:50%;background:var(--ok);flex:0 0 auto}
.rt-dot.idle{background:var(--warn)}
.badge{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:0 8px;font-size:11px;color:var(--dim);white-space:nowrap}
.rt-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-width:0}
@container (min-width:720px){.rt-tiles{grid-template-columns:repeat(4,minmax(0,1fr))}.rt-tiles.two{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (max-width:339px){.rt-tiles,.rt-tiles.two{grid-template-columns:minmax(0,1fr)}}
.rt-tiles .mt{padding:8px 9px}
.rt-chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0}
.rt-chips .chip{max-width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}
.act button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 10px;font:inherit;cursor:pointer}
.act button:hover{border-color:var(--acc);color:var(--acc)}
.act button[disabled]{opacity:.5;cursor:default}
.act .msg{color:var(--dim);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis}
.act .msg.bad{color:var(--bad)}
.lbl{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0;color:var(--dim);font-size:11px}
.lbl input{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font:inherit;min-width:0;max-width:100%}
.lbl .lblbtn{background:none;border:0;padding:0 4px;color:var(--acc);cursor:pointer;font:inherit}
.lbls{display:flex;flex-direction:column;gap:2px;min-width:0}
.tog.on{background:var(--acc);border-color:var(--acc);color:#fff}
</style></head><body>
<header><h1>PAI router cockpit</h1>
<div class="tabs" id="tabs"><button data-w="1h">1 hour</button><button data-w="24h">Today</button><button data-w="7d">Week</button></div>
<span id="stamp">loading...</span><button id="theme" type="button" title="Dark mode" aria-label="Dark mode"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="ic-moon" d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/><g class="ic-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg></button></header>
<main>
<section data-section="cloud" class="card c12"><div class="groups"><div class="grp grp-cloud"><h2>Cloud</h2><div class="gauges" id="cloud"></div></div><div class="grp grp-local"><h2>Local</h2><div class="gauges" id="local"></div></div></div></section>
<section data-section="workers" class="card c12"><h2>Workers — running and waiting<span class="tip" id="queuetip" tabindex="0" aria-label="Provider capacity queue" data-tip="Provider capacity queue">ⓘ</span></h2><div id="queuepanel"></div></section>
${POOL_PANEL_HTML}
<section data-section="models" class="card c12"><h2>Models — runtimes<span class="tip" id="modelstip" tabindex="0" aria-label="Models" data-tip="Models">ⓘ</span></h2><div id="modelspanel"></div></section>
<section data-section="system" class="card c12"><h2>System — memory, load, temperature, power</h2><div class="kpis" id="sys"></div><div id="sysservers" style="margin-top:6px"></div></section>
<section data-section="kpis" class="card c12"><div class="kpis" id="kpis"></div></section>
<section data-section="tokens" class="card c8"><h2>Tokens per bucket by kind<span class="tip" id="wnote" tabindex="0" aria-label="Token counts" data-tip="Token counts">ⓘ</span></h2><div class="ctl"><span id="mode"><button data-m="weighted">weighted</button><button data-m="raw">raw</button></span><select id="msel"></select></div><div id="series"></div><div class="legend" id="legend"></div>
<h2 style="margin-top:8px">Power and GPU/CPU load<span class="tip" tabindex="0" aria-label="Same buckets as above. W on the left axis, load % on the fixed 0-100 right axis." data-tip="Same buckets as above. W on the left axis, load % on the fixed 0-100 right axis.">ⓘ</span></h2><div id="power"></div><div class="legend" id="plegend"></div></section>
<section data-section="cache" class="card c4"><h2>Cache hit ratio<span class="tip" tabindex="0" aria-label="cache_read / (read + write + fresh input), per provider / model." data-tip="cache_read / (read + write + fresh input), per provider / model.">ⓘ</span></h2><div id="donut" class="rings"></div><div id="donutlow" class="chips lowmodels"></div><div id="donutnote" class="chips"></div>
<h2 id="donutlocaltitle" style="margin-top:8px;display:none">Local prefix cache<span class="tip" tabindex="0" aria-label="Server counters cover the time since that server started; router log rows only since the router restarted, so the two windows differ. A hit skips re-computing the cached prompt part (latency), not money." data-tip="Server counters cover the time since that server started; router log rows only since the router restarted, so the two windows differ. A hit skips re-computing the cached prompt part (latency), not money.">ⓘ</span></h2><div id="donutlocal"></div>
<h2 style="margin-top:8px">Providers<span class="tip" tabindex="0" aria-label="* server counter (prefix cache since server start; this provider reports no cache fields per request). avg ms is end-to-end incl. queueing and prefill, ttft p50 is time to first token." data-tip="* server counter (prefix cache since server start; this provider reports no cache fields per request). avg ms is end-to-end incl. queueing and prefill, ttft p50 is time to first token.">ⓘ</span></h2><div id="providers"></div></section>
<section data-section="speed" class="card c12"><h2>Speed per model<span class="tip" tabindex="0" aria-label="TTFT = request sent to first content token. Read = input tokens / TTFT (prefill incl. cached for local models; for Anthropic input excludes cache reads). Write = output tokens / decode time, replies of 16+ tokens only. Medians (p50) unless marked." data-tip="TTFT = request sent to first content token. Read = input tokens / TTFT (prefill incl. cached for local models; for Anthropic input excludes cache reads). Write = output tokens / decode time, replies of 16+ tokens only. Medians (p50) unless marked.">ⓘ</span></h2><div id="speed"></div></section>
<section data-section="pause" class="card c12"><h2>Cache verdict by pause<span class="tip" tabindex="0" aria-label="Per model. Pause = time since the previous request of the same session. A drop in hits after 5m means the cache expired between turns: a keepalive under 5m would have kept it." data-tip="Per model. Pause = time since the previous request of the same session. A drop in hits after 5m means the cache expired between turns: a keepalive under 5m would have kept it.">ⓘ</span></h2><div id="pause"></div></section>
<section data-section="sessions" class="card c12"><h2>Sessions by tokens</h2><div id="sessions"></div></section>
<section data-section="runs" class="card c6"><h2>Worker runs</h2><div id="workers"></div></section>
<section data-section="daily" class="card c6"><h2>Tokens per day per model (14 d)</h2><div id="daily"></div><div class="legend" id="dlegend"></div></section>
</main>
<script>
(function(){
var KINDS=[["input","fresh input","#3b6fe0"],["cacheWrite","cache write","#e0703b"],["cacheRead","cache read","#2e9e5b"],["output","output","#b04fd0"]],mode=localStorage.getItem("cockpitMode")||"weighted",msel="";var win=localStorage.getItem("cockpitWin")||"1h",data=null,lim=null,lastOk=0,PAL=["#3b6fe0","#e0703b","#2e9e5b","#b04fd0","#d9b31c","#2bb3c0","#d64570","#7a8a99","#8fbf3f","#a0522d"];
var colors={};function colorOf(k){for(var i=0;i<KINDS.length;i++)if(KINDS[i][0]===k)return KINDS[i][2];if(!colors[k])colors[k]=PAL[Object.keys(colors).length%PAL.length];return colors[k]}
function $(id){return document.getElementById(id)||document.createElement("div")}
function has(){for(var i=0;i<arguments.length;i++)if(document.querySelector('[data-section="'+arguments[i]+'"]'))return true;return false}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function fmt(n){n=n||0;if(n>=1e9)return(n/1e9).toFixed(2)+"G";if(n>=1e6)return(n/1e6).toFixed(2)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return String(Math.round(n))}
/** Tooltip icon: the long text lives in data-tip (CSS hover/focus) and aria-label (screen readers). */
function tip(t){return'<span class="tip" tabindex="0" aria-label="'+esc(t)+'" data-tip="'+esc(t)+'">ⓘ</span>'}
function setTip(el,t){el.setAttribute("aria-label",t);el.setAttribute("data-tip",t)}
function pct(x){return(x*100).toFixed(1)+"%"}
function tot(t){return t.input+t.output+t.cacheWrite+t.cacheRead}
function dur(ms){if(ms<=0)return"now";var s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+"d "+h+"h":h?h+"h "+String(m).padStart(2,"0")+"m":m+"m "+String(s%60).padStart(2,"0")+"s"}
function ago(iso){var s=(Date.now()-Date.parse(iso))/1000;return s<90?Math.round(s)+"s":s<5400?Math.round(s/60)+"m":s<172800?Math.round(s/3600)+"h":Math.round(s/86400)+"d"}
function sev(p){return p>=90?"var(--bad)":p>=70?"var(--warn)":"var(--ok)"}
/* metricTile: ported from Strata's "Speed" metric tile (MIT, Copyright (c) 2026 Niko1221 and the Strata contributors) */
function metricSpark(series){
 var max=0,n=0,i,s,d;
 series.forEach(function(x){(x.data||[]).forEach(function(v){if(v!=null&&isFinite(v)&&v>max)max=v});n=Math.max(n,(x.data||[]).length)});
 if(!max)max=1;
 return series.map(function(x,k){
  d=x.data||[];var line="",area="",seg=[];
  function flush(){if(seg.length){line+="M"+seg.join("L");if(seg.length>1&&k===0)area+="M"+seg[0].split(",")[0]+",32L"+seg.join("L")+"L"+seg[seg.length-1].split(",")[0]+",32Z"}seg=[]}
  for(i=0;i<d.length;i++){
   if(d[i]==null||!isFinite(d[i])){flush();continue}
   seg.push((n>1?i/(n-1)*100:50).toFixed(1)+","+(30-d[i]/max*28).toFixed(1));
  }
  flush();
  return(area?'<path class="area" fill="currentColor" opacity=".12" d="'+area+'"/>':"")+(line?'<path class="line mt-'+esc(x.tone||(k?"alt":"acc"))+'" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" d="'+line+'"/>':"")
 }).join("");
}
function metricTile(o){
 var sec=o.secondary;
 function col(v,u,sub,cls){return'<div'+(cls?' class="'+cls+'"':"")+'><span class="mt-value">'+(v==null?"–":esc(v))+(v!=null&&u?'<small>'+esc(u)+'</small>':"")+'</span><span class="mt-sub">'+esc(sub||"")+'</span></div>'}
 function fill(v,u,sub){return'<div class="mt-fill"><div class="mt-bar"><i style="width:'+Math.max(0,Math.min(100,v==null?0:v)).toFixed(1)+'%"></i></div><span class="mt-sub">'+esc(u||"")+(sub?" · "+esc(sub):"")+'</span></div>'}
 return'<div class="mt"><span class="mt-label">'+(o.icon?'<span class="mt-icon">'+esc(o.icon)+'</span>':"")+esc(o.title)+'</span>'+
  '<div class="mt-values">'+col(o.value,o.unit,o.sub)+(sec?col(sec.value,sec.unit,sec.sub,"mt-sec"):"")+'</div>'+
  (o.fill?fill(o.fill.pct,o.fill.text,o.fill.sub):"")+
  '<svg class="mt-spark" viewBox="0 0 100 32" preserveAspectRatio="none" width="100%" height="32">'+metricSpark(o.series||[])+'</svg></div>'
}
/** Collapsible tiles: every card/panel can fold; the state is saved per tile id and restored on load. */
var COLLAPSE_KEY="pai.cockpit.collapsed";
function collapsedSet(){var s={};try{var r=localStorage.getItem(COLLAPSE_KEY);if(r)JSON.parse(r).forEach(function(k){s[k]=1})}catch(e){}return s}
function saveCollapsed(s){try{var a=[];for(var k in s)if(s[k])a.push(k);localStorage.setItem(COLLAPSE_KEY,JSON.stringify(a))}catch(e){}}
function applyCollapse(){
 var cs=collapsedSet(),cards=document.querySelectorAll("main section.card");
 for(var i=0;i<cards.length;i++)(function(c){
  var h=c.querySelector("h2");if(!h)return;
  if(!c.id)c.id="tile-"+i;
  var b=h.querySelector("button.fold");
  if(!b){b=document.createElement("button");b.type="button";b.className="fold";b.setAttribute("aria-expanded","true");h.insertBefore(b,h.firstChild)}
  var col=!!cs[c.id];
  c.classList.toggle("folded",col);b.setAttribute("aria-expanded",col?"false":"true");
  b.innerHTML='<span class="chev">'+(col?"▸":"▾")+'</span>';
  b.title=col?"expand":"collapse";b.setAttribute("aria-label",(col?"expand ":"collapse ")+h.textContent.trim());
  if(!b.onclick)b.onclick=function(){var s2=collapsedSet();if(s2[c.id])delete s2[c.id];else s2[c.id]=1;saveCollapsed(s2);applyCollapse()};
 })(cards[i]);
}

function gauge(l,w,age){
 var p=Math.max(0,Math.min(100,w.percent)),r=44,cx=60,cy=56,a=Math.PI*p/100;
 var x=cx-r*Math.cos(a),y=cy-r*Math.sin(a);
 var arc='<path d="M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+(cx+r)+' '+cy+'" fill="none" stroke="var(--line)" stroke-width="10" stroke-linecap="round"/>';
 if(p>0)arc+='<path d="M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+x.toFixed(1)+' '+y.toFixed(1)+'" fill="none" stroke="'+sev(p)+'" stroke-width="10" stroke-linecap="round"/>';
 return '<div class="gauge"><svg width="120" height="70" viewBox="0 0 120 70">'+arc+'<text x="60" y="54" text-anchor="middle" style="font-size:16px;font-weight:600;fill:var(--fg)">'+Math.round(w.percent)+'%</text></svg>'+
  '<div class="n">'+esc(l.provider)+' '+esc(w.name)+(age?' <span class="warn" title="'+esc(l.error||"")+'">· '+esc(age)+' old</span>':'')+(w.estimated?' <span class="warn">estimated</span>':'')+'</div>'+
  '<div class="s" data-reset="'+(w.resetAt||0)+'">'+(w.resetAt?'resets in '+dur(w.resetAt-Date.now()):'reset unknown')+'</div></div>';
}
/** The action row shared by the model cards and the cloud gauges. */
function actRow(cls,attrs,btns,msg){
 return'<div class="act '+cls+'"'+attrs+'>'+btns+'<span class="msg">'+esc(msg||"")+'</span></div>';
}
function postAction(action,target,value,cb){
 var body={action:action};if(target!=null)body.target=target;if(value!=null)body.value=value;
 fetch("/cockpit/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),cache:"no-store"})
  .then(function(r){return r.json()}).then(function(j){cb(j)}).catch(function(){cb({ok:false,message:"action failed"})});
}
/** Buttons in an action row: disabled while the action runs; the result text lands on the card. */
function wireAct(el,onDone){
 var btns=el.querySelectorAll("button");
 for(var i=0;i<btns.length;i++)(function(b){
  b.onclick=function(){
   var cf=b.getAttribute("data-confirm");
   if(cf&&!b.confirmed){b.confirmed=true;var m0=el.querySelector(".msg");if(m0){m0.textContent=cf;m0.className="msg"}return}
   b.confirmed=false;
   for(var k=0;k<btns.length;k++)btns[k].disabled=true;
   postAction(b.getAttribute("data-a"),b.getAttribute("data-t")||null,b.getAttribute("data-v")||null,function(j){
    var m=el.querySelector(".msg");if(m){m.textContent=(j&&j.message)||"";m.className="msg"+(j&&j.ok?"":" bad")}
    for(var k=0;k<btns.length;k++)btns[k].disabled=false;
    if(onDone)onDone(j);
   });
  };
 })(btns[i]);
}
function renderLimits(){
 if(!lim)return;var c="",lo="",dn=[];
 var roles=lim.roles||{};
 lim.limits.forEach(function(l){
  var h="",age=l.error&&/usage reading /.test(l.error)&&l.fetchedAt&&l.fetchedAt<=Date.now()?ago(new Date(l.fetchedAt).toISOString()):"";
  if(l.kind==="local"){h+='<div class="gauge"><div class="n">'+esc(l.provider)+'</div><div class="'+(l.up?"ok":"bad")+'">'+(l.up?"up":"down")+'</div><div class="s">'+(l.rssMb?l.rssMb+" MB RSS":"")+(l.tokensPerSec?" · "+l.tokensPerSec+" tok/s":"")+'</div>'+(l.served&&l.served.length?'<div class="s">'+esc(l.served[0])+'</div>':'')+'</div>';if(l.up)lo+=h;else dn.push(l.provider);return}
  l.windows.forEach(function(w){h+=gauge(l,w,age)});
  if(!l.windows.length)h+='<div class="gauge"><div class="n">'+esc(l.provider)+'</div><div class="dim">no reading</div><div class="s">'+esc(l.error||"")+'</div></div>';
  else if(l.error)h+='<div class="gauge dim" title="'+esc(l.error)+'"><div class="s">'+esc(l.provider)+': '+esc(l.error)+'</div></div>';
  var r=roles[l.provider]||{workers:[],orchestrator:false};
  h+=actRow("roles",' data-prov="'+esc(l.provider)+'"',
   '<button data-a="cloud.role" data-t="'+esc(l.provider)+'" data-v="worker" class="tog'+(r.workers.length?" on":"")+'" title="worker classes → '+esc(l.provider)+'">workers</button>'+
   '<button data-a="cloud.role" data-t="'+esc(l.provider)+'" data-v="orchestrator" class="tog'+(r.orchestrator?" on":"")+'" title="orchestrator → '+esc(l.provider)+'">orchestrator</button>');
  c+=h;
 });
 $("cloud").innerHTML=c||'<span class="dim">no cloud limit sources</span>';
 if(dn.length)lo+='<details class="downs"><summary>'+dn.length+' local model'+(dn.length===1?'':'s')+' down</summary>'+dn.map(function(n){return'<span class="chip bad">'+esc(n)+'</span>'}).join(" ")+'</details>';
 $("local").innerHTML=lo||'<span class="dim">no local providers</span>';
 var els=document.querySelectorAll("#cloud .act");
 for(var i=0;i<els.length;i++)wireAct(els[i],loadLimits);
}
var mdl=null;
/** Short model name: the last path segment of the id ("huggingface.co/…/multilingual-e5-base" → "multilingual-e5-base");
 * the full id rides in the title attribute. */
function shortModel(m){var s=String(m==null?"":m),i=s.lastIndexOf("/");return i>=0?s.slice(i+1):s}
/** Models section: one card per running runtime with live tiles (Speed, Memory, Workers, Conversation cache);
 * an idle / not-loaded runtime gets a compact card (header + Memory/size + users, no empty tiles); a runtime
 * with a loaded model keeps all four tiles — a "–" there means the engine did not report it, not an idle runtime;
 * stopped runtimes collapse to one chip row that never repeats a card. A value the runtime does not report shows "–". */
function modelsHtml(inv){
 if(!inv||!inv.runtimes)return"";
 var tiers=inv.tiers||[];
 var running=(inv.running&&inv.running.model)?inv.running:null;
 var tierBtns=tiers.map(function(t){return'<button data-a="local.switch" data-t="'+esc(t)+'"'+(running&&running.tier===t?' disabled':"")+(running?' data-confirm="stops '+esc(running.model)+' first, needs ~'+esc(running.memGb||"?")+' GB. Click again to confirm."':"")+'>'+esc(t)+'</button>'}).join("")+(tiers.length?'<button data-a="local.off">off</button>':"");
 /** Label row: the label as subtitle, click → text field, Enter saves, Esc cancels. */
 function lblRow(r){
  var ml=r.modelLabels||{};
  var parts='<span class="lbl" data-rt="'+esc(r.name)+'">label: <b class="lblv">'+esc(r.label||"")+'</b><button class="lblbtn" title="edit label">edit</button><span class="msg"></span></span>';
  var mrows=r.models.map(function(m){return'<span class="lbl" data-rt="'+esc(r.name)+'" data-model="'+esc(m.model)+'">· '+esc(shortModel(m.model))+': <b class="lblv">'+esc(ml[m.model]||"")+'</b><button class="lblbtn" title="edit model label">edit</button><span class="msg"></span></span>'}).join("");
  return'<div class="lbls">'+parts+mrows+'</div>';
 }
 function mem(m){return m==null?"–":m>=1024?(m/1024).toFixed(1)+" GB":m+" MB"}
 function n1(v){return v==null?"–":Math.round(v*10)/10}
 function n0(v){return v==null?"–":Math.round(v)}
 function gb(v){return v==null?"–":(v/1024).toFixed(1)}
 /* the same rounding as Strata's monitor (serve/web/app.js): decode 1 decimal, prefill integer, GB binary */
 function f1(v){return v==null?"–":Number(v).toFixed(1)}
 function g1(v){return v==null?"–":(v/1073741824).toFixed(1)}
 function g0(v){return v==null?"–":Math.round(v/1073741824)}
 function kfmt(n){return n==null?"–":n>=1000?(n>=10000?Math.round(n/1000)+"k":(n/1000).toFixed(1)+"k"):String(n)}
 function ctxfmt(n){return n&&n%1024===0?Math.round(n/1024)+"K":kfmt(n)}
 /** Strata's Speed tile: decode = the running request, else the last one; prefill = this request, else the last. */
 function speedTile(eng,h){
  var st=eng&&eng.phase;
  var sub=st==="generating"?"Decode now":st==="reading"?"Decode":eng&&eng.lastDecode!=null?"Decode last request":"Decode";
  var psub=st==="reading"?"Prefill now":st==="generating"?"Prefill this request":eng&&eng.lastPromptMs?"Prefill last request":"Prefill";
  return metricTile({title:"Speed",value:f1(eng&&eng.decode),unit:eng&&eng.decode!=null?"t/s":"",sub:(eng&&eng.phase?esc(eng.phase)+" · ":"")+sub,
   secondary:{value:n0(eng&&eng.prefill),unit:eng&&eng.prefill!=null?"t/s":"",sub:psub},
   series:[{data:h.decode||[]},{data:h.prefill||[]}]})
 }
 /** Strata's VRAM measure (the engine's hardware reading) beside the process RSS. */
 function memoryTile(eng,lv,loaded,h){
  var ram=lv&&lv.rssMb!=null?lv.rssMb:(loaded.reduce(function(a,m){return a+(m.memoryMb||0)},0)||null);
  var gpu=eng&&eng.gpuMemUsed!=null,sub="RAM"+(ram!=null?" "+gb(ram)+" GB":" · not reported")+(gpu?" · GPU "+g1(eng.gpuMemUsed)+(eng.gpuMemTotal!=null?" / "+g0(eng.gpuMemTotal)+" GB":""):" · GPU not reported");
  return metricTile({title:"Memory",value:ram!=null?gb(ram):"–",unit:ram!=null?"GB":"",sub:sub+(loaded[0]&&loaded[0].mappedMb?" · "+gb(loaded[0].mappedMb)+" GB file mapped":"")+(h.pressurePct&&h.pressurePct.length?" · machine pressure "+n0(h.pressurePct[h.pressurePct.length-1])+"%":""),
   series:[{data:h.memoryMb||[]}]})
 }
 /** Strata's context fill: the running request's tokens, else the last one's, over the engine's max context. */
 function ctxOf(eng){
  if(!eng||eng.maxContext==null)return null;
  var used=eng.liveUsed!=null?eng.liveUsed:eng.lastUsed;
  if(used==null)return null;
  return {pct:Math.min(100,used/eng.maxContext*100),text:Math.round(used/eng.maxContext*100)+"% · "+kfmt(used)+" / "+ctxfmt(eng.maxContext)}
 }
 function liveOf(r){var l=(inv.live&&inv.live.runtimes||[]).filter(function(x){return x.name===r.name})[0];return l?Object.assign({},l.live,{history:l.history}):null}
 var cards="",stopped=[];
 inv.runtimes.forEach(function(r){
  if(r.status==="stopped"){stopped.push(r);return}
  var lv=liveOf(r),eng=lv&&lv.engine,h=lv&&lv.history||{},w=(lv&&lv.workers||[]);
  var loaded=r.models.filter(function(m){return m.loaded});
  var head='<div class="rt-head"><span class="rt-dot'+(r.status==="idle"?" idle":"")+'"></span><b'+(r.models.length?' title="'+esc(r.models[0].model)+'"':"")+'>'+esc(r.models.length?shortModel(r.models[0].model):r.name)+'</b>'+
   (r.kind===r.name||r.kind===r.name+(r.port==null?"":" :"+r.port)?"":'<span class="badge">'+esc(r.kind)+'</span>')+'<span class="badge">'+esc(r.name)+(r.port==null?"":" :"+r.port)+'</span>'+
   '<span class="badge">'+(r.status==="idle"?"idle":"running")+'</span></div>'+
   '<div class="rt-sub"'+(r.users&&r.users.length?' title="'+esc(r.users.join(", "))+'"':"")+'>'+esc(r.label||"")+(r.label&&r.users&&r.users.length?" · ":"")+(r.users&&r.users.length?"used by "+esc(r.users.join(", ")):"")+'</div>';
  var act=actRow("rt-act",' data-rt="'+esc(r.name)+'"',tierBtns);
  // compact card: nothing loaded (idle runtime) — no Speed / Conversation cache tiles that would show only "–"
  if(!loaded.length){
   var size=r.models.reduce(function(a,m){return a+(m.sizeMb||0)},0)||null;
   cards+='<div class="rt-card">'+head+lblRow(r)+'<div class="rt-tiles two">'+
    metricTile({title:"Memory / size",value:mem(size),unit:"",sub:r.models.length+" model"+(r.models.length===1?"":"s")+" not loaded",series:[]})+
    metricTile({title:"Users",value:(r.users||[]).length,unit:"",sub:(r.users||[]).length?esc(r.users.join(", ")):"no declared consumer",series:[]})+
    '</div>'+act+'</div>';
   return;
  }
  var ctx=ctxOf(eng);
  var tiles='<div class="rt-tiles">'+
   speedTile(eng,h)+
   memoryTile(eng,lv,loaded,h)+
   metricTile({title:"Workers",value:w.filter(function(x){return x.state==="running"}).length,unit:"",sub:(lv&&lv.cap!=null?"cap "+lv.cap:"cap –")+" · queued "+((lv&&lv.queued)||0)+(lv&&lv.conversationSlots!=null?" · conv slots "+lv.conversationSlots:"")+(lv&&lv.sparesReady?" · "+lv.sparesReady+" spare(s) ready":lv&&lv.sparesConfig?" · spares: none ready":""),
    series:[{data:h.queued||[]}]})+
   metricTile({title:"Conversation cache",value:eng&&eng.parked!=null?eng.parked:"–",unit:eng&&eng.parked!=null?"/ "+(eng.slots!=null?eng.slots:"–"):"",
    sub:eng&&eng.reusedPct!=null?"reused "+pct(eng.reusedPct/100)+" of prompt tokens":"prompt reuse not reported",
    fill:ctx?{pct:ctx.pct,text:ctx.text}:null,
    series:[{data:h.reusedPct||[]}]})+'</div>';
  var chips=w.map(function(x){return'<span class="chip" title="'+esc(x.id)+'">'+esc(x.label||x.id)+' <b>'+esc(x.session||"?")+'</b>'+(x.state==="queued"?' <span class="warn">queued</span>':"")+'</span>'}).join("");
  cards+='<div class="rt-card">'+head+lblRow(r)+tiles+(chips?'<div class="rt-chips">'+chips+'</div>':"")+act+'</div>';
 });
 var h='<div class="rt-grid">'+(cards||'<span class="dim">no runtime running</span>')+'</div>';
 // one chip per stopped runtime (no card): never repeats a card, each chip ellipsised inside the card width
 if(stopped.length)h+='<div class="rt-chips dim" style="margin-top:6px">'+stopped.map(function(r){
  var t=esc(r.name)+(r.port==null?"":" :"+r.port)+(r.users&&r.users.length?" · used by "+esc(r.users.join(", ")):"");
  return'<span class="chip" title="'+t+'">'+t+'</span>'}).join("")+'</div>';
 if(stopped.length)h+='<div class="rt-chips" style="margin-top:6px">'+actRow("rt-act","",tierBtns)+'</div>';
 (inv.duplicates||[]).forEach(function(d){h+='<div class="warn">duplicates: '+esc(d)+'</div>'});
 return h;
}
function renderModels(){
 var el=$("modelspanel");if(!el)return;
 el.innerHTML=mdl?modelsHtml(mdl):'<span class="dim" title="loading: first models poll pending">…</span>';
 setTip($("modelstip"),mdl&&mdl.at?"Local model runtimes with live tiles (the router samples each running runtime every 5 s; a value the runtime does not report shows –). In use = a worker provider, the PAI embedding backend or a declared consumer (config models.consumers). Inventory at "+mdl.at.slice(0,16).replace("T"," "):"Models");
 var acts=el.querySelectorAll(".act");
 for(var i=0;i<acts.length;i++)wireAct(acts[i],function(j){if(j&&j.jobId)watchJob(j.jobId);else loadModels()});
 var lbls=el.querySelectorAll(".lbl");
 for(var k=0;k<lbls.length;k++)(function(sp){
  var btn=sp.querySelector(".lblbtn"),v=sp.querySelector(".lblv");
  btn.onclick=function(){
   var inp=document.createElement("input");inp.type="text";inp.value=v.textContent||"";inp.placeholder="what is this for?";
   sp.replaceChild(inp,v);inp.focus();
   var msg=sp.querySelector(".msg");
   function save(){
    var val2=inp.value;var back=document.createElement("b");back.className="lblv";back.textContent=val2;
    if(sp.parentNode.contains(inp))sp.replaceChild(back,inp);
    back.onclick=btn.onclick;
    for(var x=0;x<acts.length;x++){var bb=acts[x].querySelectorAll("button");for(var y=0;y<bb.length;y++)bb[y].disabled=true}
    postAction("model.label",sp.getAttribute("data-rt"),sp.getAttribute("data-model")?("model:"+sp.getAttribute("data-model")+"="+val2):val2,function(j2){
     msg.textContent=(j2&&j2.message)||"";msg.className="msg"+(j2&&j2.ok?"":" bad");
     for(var x=0;x<acts.length;x++){var bb=acts[x].querySelectorAll("button");for(var y=0;y<bb.length;y++)bb[y].disabled=false}
     if(j2&&j2.ok)loadModels();
    });
   }
   inp.onkeydown=function(e){if(e.key==="Enter")save();else if(e.key==="Escape"){var back2=document.createElement("b");back2.className="lblv";back2.textContent=v.textContent||"";sp.replaceChild(back2,inp);back2.onclick=btn.onclick}};
  };
 })(lbls[k]);
}
/** A local switch/off job: poll its state; the card refreshes from the inventory. */
function watchJob(id){
 var tries=0;
 function step(){
  fetch("/cockpit/job?id="+encodeURIComponent(id),{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){
   var el=$("modelspanel");var msgs=el.querySelectorAll(".act .msg");
   for(var i=0;i<msgs.length;i++)msgs[i].textContent=(j&&j.message)||"";
   if(j&&(j.state==="done"||j.state==="failed")){loadModels();return}
   if(++tries<120)setTimeout(step,5000);
  }).catch(function(){if(++tries<120)setTimeout(step,5000)});
 }
 setTimeout(step,2000);
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
  ["ANE load",val("ane",pctf),"neural engine"+tag(),"ane"],
  ["SoC temp",val("socTemp",function(v){return v.toFixed(1)+" °C"}),"IOReport"+tag()],
  ["CPU W",val("cpuW",w1),"CPU rail"+tag(),"cpuW"],
  ["GPU W",val("gpuW",w1),"GPU rail"+tag(),"gpuW"],
  ["ANE W",val("aneW",w1),"neural engine"+tag(),"aneW"],
  ["system W",val("systemW",w1),"system rail"+tag()],
  ["power",val("totalW",function(v){return w1(v)+" W"}),"SoC total"+tag()],
  ["energy "+win,wh+" Wh",cov+" min of 1-min samples"]
 ];
 var hid=[],ss=(sys.series&&sys.series.series)||[];
 /** Unused metric: the window has samples for it and every one is 0 (no samples = unknown, stays visible). */
 function unused(key){var n=0;for(var i=0;i<ss.length;i++){var v=ss[i][key];if(v==null)continue;if(v!==0)return false;n++}return n>0&&!(c[key]>0)}
 kpis=kpis.filter(function(k){if(k[3]&&unused(k[3])){hid.push(k[0]);return false}return true});
 $("sys").innerHTML=kpis.map(function(k){return'<div class="kpi"><b>'+k[1]+'</b><span>'+esc(k[0])+'</span><span style="display:block;color:var(--dim)">'+k[2]+'</span></div>'}).join("")+(hid.length?'<div class="dim" style="flex-basis:100%;font-size:11px" title="Every sample in the selected window reads 0 for these; they reappear as soon as a non-zero reading arrives.">hidden: '+esc(hid.join(", "))+' (0 in this window)</div>':"");
 var allSrv=sys.servers||[];
 var srv=allSrv.filter(function(s){return s.up!==false});
 function dec(p){var r=((data&&data.speed)||[]).filter(function(x){return x.provider===p&&(x.h1.writeTps!=null||x.h24.writeTps!=null)})[0];if(!r)return'<span class="dim">-</span>';return fmt(r.h1.writeTps!=null?r.h1.writeTps:r.h24.writeTps)}
$("sysservers").innerHTML=srv.length?table(["local server","status","RSS","end-to-end tok/s","decode tok/s","prefix cache"],srv.map(function(s){return[esc(s.provider),'<span class="'+(s.up?"ok":"bad")+'">'+(s.up?"up":"down")+'</span>',s.rssMb!=null?s.rssMb+" MB":'<span class="dim">n/a</span>',s.tokensPerSec!=null?s.tokensPerSec:'<span class="dim">-</span>',dec(s.provider),s.prefixCache?pct(s.prefixCache.hitRate)+" ("+s.prefixCache.hits+"/"+(s.prefixCache.hits+s.prefixCache.misses)+")":lim?'<span class="dim">not reported</span>':'<span class="dim" title="loading: first limits poll pending">…</span>']})):'<span class="dim">'+(allSrv.length?"all local model servers down":"no local model servers configured")+'</span>';
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
 $("plegend").innerHTML=PKEYS.map(function(k){return'<span><i style="background:'+k[2]+'"></i>'+esc(k[1])+'</span>'}).join("");
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
 var r=48,c=2*Math.PI*r,d=c*ratio;sz=sz||84;
 return'<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 140 140"><circle cx="70" cy="70" r="'+r+'" fill="none" stroke="var(--line)" stroke-width="16"/><circle cx="70" cy="70" r="'+r+'" fill="none" stroke="'+(ratio>.8?"var(--ok)":ratio>.5?"var(--warn)":"var(--bad)")+'" stroke-width="16" stroke-dasharray="'+d.toFixed(1)+' '+c.toFixed(1)+'" transform="rotate(-90 70 70)"/><text x="70" y="'+(sz>120?79:76)+'" text-anchor="middle" style="font-size:'+(sz>120?28:22)+'px;font-weight:600;fill:var(--fg)">'+pct(ratio)+'</text></svg>';
}
function emptyRing(sz){
 sz=sz||84;
 return'<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 140 140"><circle cx="70" cy="70" r="48" fill="none" stroke="var(--line)" stroke-width="16"/></svg>';
}
var LOW_REQ=5;
/** Models under LOW_REQ requests: one chip line under the grid, details on hover. */
function lowChips(ms){
 var low=Object.keys(ms).map(function(k){return ms[k]}).filter(function(m){return m.requests<LOW_REQ});
 if(!low.length)return"";
 var tt=low.map(function(m){var dn=m.cacheRead+m.cacheWrite+m.input;return m.provider+" · "+m.model+": "+m.requests+" req"+(dn&&m.cacheRead+m.cacheWrite>0?", hit "+pct(m.cacheRead/dn):"")}).join("\n");
 return'<span class="chip dim" title="'+esc(tt)+'">+'+low.length+' model'+(low.length===1?'':'s')+' with &lt;'+LOW_REQ+' requests</span>';
}
/** One tile per provider/model, all the same shape: ring, provider, model + req. Loopback without cache fields: the server prefix-cache ring, else an empty ring. Models under LOW_REQ requests are dimmed, sorted last and never red. */
function ringTiles(ms,servers){
 var list=Object.keys(ms).map(function(k){return ms[k]}).filter(function(m){return m.requests>=LOW_REQ});
 list.sort(function(a,b){var la=a.requests<LOW_REQ?1:0,lb=b.requests<LOW_REQ?1:0;return la!==lb?la-lb:b.requests-a.requests});
 return list.map(function(m){
  var dn=m.cacheRead+m.cacheWrite+m.input,low=m.requests<LOW_REQ,ring,cap="";
  var srv=(servers||[]).filter(function(s){return s.provider===m.provider})[0];
  if(m.cacheRead+m.cacheWrite>0){var r=dn?m.cacheRead/dn:0;ring=low?(r>0?donut(r):emptyRing()):donut(r)}
  else if(srv&&srv.prefixCache&&!low){ring=donut(srv.prefixCache.hitRate);cap='<div class="s" title="Hit rate of the local server\'s own prefix cache (server counter since server start); this provider reports no cache fields per request.">server prefix cache'+ageMark(srv)+'</div>'}
  else{ring=emptyRing();cap='<div class="s">'+(lim?"not reported":'<span class="dim" title="loading: first limits poll pending">…</span>')+'</div>'}
  return'<div class="ring">'+ring+'<div class="n">'+esc(m.provider)+'</div><div class="s">'+esc(m.model)+' · '+m.requests+' req</div>'+cap+'</div>'
 }).join("");
}
/** hit% cell of the providers table: loopback providers report no cache fields, so show the server counter, marked. */
/** " (Ns old)" when the server counter is a kept reading older than one poll interval (60 s). */
function ageMark(s){
 return s&&s.prefixCacheAgeSec>60?' <span class="dim">('+(s.prefixCacheAgeSec>=120?Math.round(s.prefixCacheAgeSec/60)+' min':s.prefixCacheAgeSec+'s')+' old)</span>':''
}
function provHit(p,servers){
 var srv=(servers||[]).filter(function(s){return s.provider===p.provider})[0];
 if(p.cacheRead+p.cacheWrite>0||!srv)return pct(p.hitRatio);
 return srv.prefixCache?'<span title="server prefix-cache counter since server start">'+pct(srv.prefixCache.hitRate)+'*</span>'+ageMark(srv):'<span class="dim">n/a</span>';
}
/** Line under a local server's ring: tokensSaved (server counter, since server start) against the router log's prompt total (since its first row). */
function reuseLine(pc,tot,since){
 var w=since?" since "+since.slice(0,16).replace("T"," "):"";
 if(!tot)return'<div class="s dim" title="Prompt tokens served from cache: '+fmt(pc.tokensSaved)+' saved (server counter, since server start); no prompt tokens in the router log.">cached '+fmt(pc.tokensSaved)+' · no log</div>';
 if(tot<pc.tokensSaved)return'<div class="s" title="Prompt tokens served from cache: '+fmt(pc.tokensSaved)+' saved (server counter, since server start) vs '+fmt(tot)+' prompt tokens in the router log'+w+' — windows differ, no ratio.">cached '+fmt(pc.tokensSaved)+' vs '+fmt(tot)+' (windows differ)</div>';
 return'<div class="s" title="Prompt tokens served from cache: '+fmt(pc.tokensSaved)+' saved by the server since it started, of '+fmt(tot)+' prompt tokens in the router log'+w+'.">cached '+pct(pc.tokensSaved/tot)+' · '+fmt(pc.tokensSaved)+' / '+fmt(tot)+'</div>';
}
/** One compact line per loopback provider (no ring: the providers grid tile already shows the hit rate). */
function localDetail(prov,pc,tot,age){
 var mem=(pc.entries!=null?pc.entries+" entries":"")+(pc.entries!=null&&pc.memoryMb!=null?" / ":"")+(pc.memoryMb!=null?Math.round(pc.memoryMb)+" MB":"");
 return'<div class="s"><b>'+esc(prov)+'</b> · '+pc.hits+' hit / '+pc.misses+' miss · '+fmt(pc.tokensSaved)+' tokens saved (server, since start)'+(mem?' · '+mem:'')+(tot?' · router log: '+fmt(tot)+' prompt tokens (since restart)':'')+(age||'')+'</div>';
}
function table(head,rows,tips){return'<div class="tw"><table><tr>'+head.map(function(h){return'<th'+(tips&&tips[h]?' title="'+esc(tips[h])+'"':'')+'>'+h+'</th>'}).join("")+'</tr>'+rows.map(function(r){return'<tr>'+r.map(function(c){return'<td>'+c+'</td>'}).join("")+'</tr>'}).join("")+'</table></div>'}
/** Cache rings for the c4 card: cloud per model, then per model served by a local server (mapping from /cockpit/system). */
function reuse(prov,pc){return reuseLine(pc,(data.promptByProvider||{})[prov],(data.promptSince||{})[prov])}
function renderSpeed(){
 var sp=(data&&data.speed)||[];
 function c(st,k,u){return st[k]==null?'<span class="dim">-</span>':fmt(st[k])+u}
 $("speed").innerHTML=sp.length?table(["provider","model","req 1h / 24h","TTFT p50 1h","p90 1h","TTFT p50 24h","p90 24h","read tok/s 1h","24h","write tok/s 1h","24h"],sp.map(function(r){return[esc(r.provider),esc(r.model),r.h1.requests+" / "+r.h24.requests,c(r.h1,"ttftP50"," ms"),c(r.h1,"ttftP90"," ms"),c(r.h24,"ttftP50"," ms"),c(r.h24,"ttftP90"," ms"),c(r.h1,"readTps",""),c(r.h24,"readTps",""),c(r.h1,"writeTps",""),c(r.h24,"writeTps","")]}),{"TTFT p50 1h":"Median time from request sent to first content token, last hour.","TTFT p50 24h":"Median time from request sent to first content token, last 24 hours.","p90 1h":"90th percentile TTFT, last hour.","p90 24h":"90th percentile TTFT, last 24 hours.","read tok/s 1h":"Input tokens / TTFT (prefill incl. cached for local models; Anthropic input excludes cache reads).","write tok/s 1h":"Output tokens / decode time, replies of 16+ tokens only."}):'<span class="dim" title="Timing is recorded for streamed replies since the router restart.">no timed requests yet</span>';
}
function renderDonuts(){ renderSpeed();
 if(!data)return;var d=data,t=d.totals,ms={};
 d.byModel.forEach(function(m){var k=m.provider+"\u0000"+m.model,o=ms[k]||(ms[k]={provider:m.provider,model:m.model,cacheRead:0,cacheWrite:0,input:0,requests:0});o.cacheRead+=m.cacheRead;o.cacheWrite+=m.cacheWrite;o.input+=m.input;o.requests+=m.requests});
 var mk=Object.keys(ms),dh="",allSrv2=(sys&&sys.servers)||[];
 if(mk.length===1&&ms[mk[0]].cacheRead+ms[mk[0]].cacheWrite>0){var m=ms[mk[0]],dn=m.cacheRead+m.cacheWrite+m.input;
  dh='<div class="solo">'+donut(dn?m.cacheRead/dn:0,170)+'<div class="bignum">'+pct(t.hitRatio)+'<span>overall hit ratio</span><span>'+esc(m.provider)+' · '+esc(m.model)+' · '+m.requests+' req</span></div></div>';
 }else dh=ringTiles(ms,allSrv2);
 var lowc=dh.indexOf('class="solo"')>=0?"":lowChips(ms);
 $("donut").innerHTML=dh||(lowc?"":'<span class="dim">no data</span>');
 $("donutlow").innerHTML=lowc;
 function chip(l,v,tt){return'<span class="chip"'+(tt?' title="'+esc(tt)+'"':'')+'>'+l+' <b>'+v+'</b></span>'}
 var note=chip("overall",pct(t.hitRatio),"cache_read / (read + write + fresh input), all providers and models");
 var sk=d.sessionSplit;
 if(sk)note+=chip("continuous",pct(sk.continuous.hitRatio)+" ("+sk.continuous.sessions+" sess)","continuous sessions: "+sk.continuous.sessions+" sessions, "+sk.continuous.requests+" requests")+chip("one-shot",pct(sk.oneShot.hitRatio)+" ("+sk.oneShot.sessions+" sess)","one-shot sessions: "+sk.oneShot.sessions+" sessions, "+sk.oneShot.requests+" requests");
 if(d.pool&&d.pool.tasks)note+=chip("pool",d.pool.tasks+" task(s) · "+fmt(d.pool.tokensCarried),d.pool.tasks+" task(s), "+fmt(d.pool.tokensCarried)+" tokens carried");
 $("donutnote").innerHTML=note;
 var loc=(sys&&sys.servers||[]).filter(function(s){return s.up!==false});
 var lh="";
 loc.forEach(function(s){if(s.prefixCache)lh+=localDetail(s.provider,s.prefixCache,(data.promptByProvider||{})[s.provider],ageMark(s))});
 $("donutlocaltitle").style.display=lh?"":"none";
 $("donutlocal").innerHTML=lh;
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
 $("legend").innerHTML=KINDS.map(function(k){return'<span><i style="background:'+k[2]+'"></i>'+k[1]+(wt?' x'+W[k[0]]:'')+'</span>'}).join("")+(msel?"":'<span><i style="background:'+colorOf("input")+';opacity:.25"></i>total (light)</span><span><i style="background:'+colorOf("input")+'"></i>non-cached (solid)</span>'+models.map(function(m){return'<span><i style="background:'+colorOf(m)+'"></i>'+esc(m)+'</span>'}).join(""))+(gap?'<span class="dim" title="Idle buckets are compressed: the x axis is not time-linear.">idle compressed</span>':"");
 setTip($("wnote"),wt?"Weighted: tokens times Anthropic price ratios relative to fresh input (cache read "+W.cacheRead+", cache write "+W.cacheWrite+", output "+W.output+"). The same ratios are applied to every other provider, whatever its real prices.":"Raw: token counts as reported.");
 var mb=document.querySelectorAll("#mode button");for(var i=0;i<mb.length;i++){mb[i].className=mb[i].getAttribute("data-m")===mode?"on":"";mb[i].onclick=function(){mode=this.getAttribute("data-m");localStorage.setItem("cockpitMode",mode);render()}}
 renderDonuts();
 var ph=d.cachePause.map(function(cm){
  var cells=cm.buckets.map(function(b){if(!b.n)return'<td class="dim">-</td>';var hr=b.hit/b.n;return'<td><span class="'+(hr<.5?"bad":hr<.8?"warn":"ok")+'">'+Math.round(hr*100)+'%</span> <span class="dim">'+b.n+'</span></td>'}).join("");
  return'<tr><td>'+esc(cm.model)+'</td>'+cells+'</tr>'}).join("");
 var labs=d.cachePause.length?d.cachePause[0].buckets.map(function(b){return b.label}):[];
 $("pause").innerHTML=ph?'<table><tr><th>model (hit% n)</th>'+labs.map(function(l){return'<th>'+esc(l)+'</th>'}).join("")+'</tr>'+ph+'</table>':'<span class="dim">no data</span>';
 $("providers").innerHTML=table(["provider","req","err%","retries","avg ms","ttft p50","hit%","tokens"],d.byProvider.map(function(p){var e=p.errors/Math.max(1,p.requests);return[esc(p.provider),p.requests,'<span class="'+cls(e,.02,.1)+'">'+pct(e)+'</span>','<span class="'+(p.retries?"warn":"")+'">'+p.retries+'</span>',p.avgMs,p.ttftP50!=null?fmt(p.ttftP50)+' ms':'<span class="dim">-</span>',provHit(p,(sys&&sys.servers)||[]),fmt(tot(p))]}),{"avg ms":"Average end-to-end milliseconds incl. queueing and prefill.","ttft p50":"Median time from request sent to first token.","retries":"Retried upstream calls.","hit%":"cache_read / (read + write + fresh input); * = server counter."})+
  '<div class="dim">Busts: '+(Object.keys(d.bustParts).length?Object.keys(d.bustParts).map(function(k){return esc(k)+" x"+d.bustParts[k]}).join(", "):"none")+'</div>';
 $("sessions").innerHTML=table(["session","models","req","tokens","fresh in","out","hit%","busts","errors","last"],d.bySession.slice(0,20).map(function(s){var nm=s.name?esc(s.name)+' <span class="dim">· '+esc(s.session.slice(0,8))+'</span>':esc(s.session.slice(0,8));var v=s.worker?' <span class="'+(s.verdict==="ok"?"ok":s.verdict==="failed"?"bad":"dim")+'" title="worker '+esc(s.worker||"")+'">'+esc(s.verdict||"worker")+'</span>':'';return['<span title="'+esc(s.session)+'">'+nm+v+'</span>',esc(s.models.join(", ")),s.requests,fmt(tot(s)),fmt(s.input+s.cacheWrite),fmt(s.output),'<span class="'+(s.hitRatio<.5?"bad":s.hitRatio<.8?"warn":"ok")+'">'+pct(s.hitRatio)+'</span>','<span class="'+(s.busts?"warn":"")+'">'+s.busts+'</span>',s.errors,ago(s.lastTs)]}));
 $("workers").innerHTML=d.workers.length?table(["worker","label","provider","req","tokens","verdict"],d.workers.slice(0,15).map(function(s){return[esc(s.worker),esc(s.name||"-"),esc(s.workerProvider||"-"),s.requests,fmt(tot(s)),'<span class="'+(s.verdict==="ok"?"ok":s.verdict==="failed"?"bad":"dim")+'">'+esc(s.verdict||"worker")+'</span>']})):'<span class="dim">no worker sessions in this window</span>';
 var dm=Object.keys(d.daily.models),ds=d.daily.days.map(function(t,i){var o={};dm.forEach(function(m){o[m]=d.daily.models[m][i]});return o});
 var dgap=stackedBars($("daily"),d.daily.days.map(function(t){return new Date(t).toLocaleDateString([],{day:"numeric",month:"numeric"})}),ds,dm,520,200);
 legend($("dlegend"),dm);if(dgap)$("dlegend").innerHTML+='<span class="dim" title="Idle buckets are compressed: the x axis is not time-linear.">idle compressed</span>';
}
function load(){
 fetch("/cockpit/data?window="+win,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){data=j;lastOk=Date.now();render()}).catch(function(){});
}
function loadSystem(){fetch("/cockpit/system?window="+win,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){sys=j;renderSystem();renderPower();renderDonuts()}).catch(function(){})}
${POOL_PANEL_JS}
var qdrag=false;
function renderQueue(q){
 if(qdrag)return;
 var el=$("queuepanel");if(!q){el.innerHTML='<span class="dim">queue status unavailable</span>';return}
 function qdur(s){return s<90?s+"s":s<5400?Math.floor(s/60)+"m"+String(s%60).padStart(2,"0")+"s":Math.floor(s/3600)+"h"+String(Math.floor(s%3600/60)).padStart(2,"0")+"m"}
 setTip($("queuetip"),"Workers by the session that started them, then by model. A serialising provider (cap 1, e.g. the local model) has its own block on top: its queue is shared across sessions. Drag a waiting row (or use next / up) to reorder it; running workers are never interrupted.");
 var ps=(q.providers||[]).filter(function(p){return p.running.length||p.waiting.length});
 var pl=q.plans||[];
 var bq=q.builds,bhas=bq&&(bq.running.length||bq.waiting.length);
 var wt=q.worktrees?'<div class="dim">'+esc(q.worktrees)+'</div>':'';
 if(!ps.length&&!bhas&&!pl.length){el.innerHTML='<span class="dim">nothing running or waiting</span>'+wt;return}
 var BTN='<button data-q="next" data-id="@" title="runs next; the running worker is not interrupted">next</button> <button data-q="up" data-id="@" title="move one place up">up</button>';
 function mk(it,p,waiting,serial){
  var idle=!waiting&&it.ageSec>86400,mdl=esc(p.provider+"/"+(it.model||"?"));
  var cells=[waiting?String(it.position):"",(waiting&&serial?'<span class="grip" title="drag to reorder">&#8942;&#8942;</span> ':'')+'<span title="'+esc(it.id+" · "+it.label)+'">'+esc(it.label||it.id)+'</span>'];
  if(serial)cells.push(esc(it.session||"other"));else cells.push(mdl);
  cells.push(waiting?'waiting':idle?'idle session':'running',qdur(waiting?it.waitedSec:it.ageSec),waiting?'':esc(idle?"":it.now||""),waiting?BTN.split("@").join(esc(it.id)):"");
  var drag=waiting&&serial;
  return'<tr class="'+(idle?'dim':'')+(drag?' qrow':'')+'"'+(drag?' draggable="true" data-id="'+esc(it.id)+'" data-prov="'+esc(p.provider)+'" data-pos="'+it.position+'"':'')+'>'+cells.map(function(c,i){return'<td style="text-align:'+(i===1||i===2||i===5?'left':'right')+'">'+c+'</td>'}).join("")+'</tr>'
 }
 function block(title,head,rows){return'<div style="margin-bottom:10px"><div style="margin-bottom:2px"><b>'+title+'</b></div><div class="tw"><table><tr>'+head.map(function(h){return'<th>'+h+'</th>'}).join("")+'</tr>'+rows.join("")+'</table></div></div>'}
 var out=[],sess={};
 ps.forEach(function(p){
  if(p.cap===1){
   var rows=p.running.map(function(r){return mk(r,p,false,true)}).concat(p.waiting.map(function(w){return mk(w,p,true,true)}));
   var mods={};p.running.concat(p.waiting).forEach(function(x){if(x.model)mods[x.model]=1});
   out.push(block(esc(p.provider)+(Object.keys(mods).length?': '+esc(Object.keys(mods).join(", ")):'')+' (slots '+p.running.length+'/1'+(p.conversationSlots?', conversation slots '+p.conversationSlots:'')+')',["pos","worker","session","state","age / waited","now","move"],rows.concat(p.waiting.length?[]:['<tr><td colspan="7" class="dim" style="text-align:left">nothing waiting</td></tr>'])));
   return}
  p.running.forEach(function(r){(sess[r.session||"other"]=sess[r.session||"other"]||[]).push({k:p.provider+"/"+(r.model||"?"),h:mk(r,p,false,false)})});
  p.waiting.forEach(function(w){(sess[w.session||"other"]=sess[w.session||"other"]||[]).push({k:p.provider+"/"+(w.model||"?"),h:mk(w,p,true,false)})});
 });
 Object.keys(sess).sort(function(a,b){return a==="other"?1:b==="other"?-1:a<b?-1:a>b?1:0}).forEach(function(s){
  var it=sess[s].sort(function(a,b){return a.k<b.k?-1:a.k>b.k?1:0}),cnt={};it.forEach(function(x){cnt[x.k]=(cnt[x.k]||0)+1});
  out.push(block(esc(s)+((q.sessionMax||{})[s]?' <span class="dim">max '+q.sessionMax[s]+' at a time</span> ':'')+' <span class="dim">'+Object.keys(cnt).map(function(k){return esc(k)+" ×"+cnt[k]}).join(", ")+'</span>',["pos","worker","model","state","age / waited","now","move"],it.map(function(x){return x.h})))
 });
 if(bhas){
  [["test","tests",bq.testSlots],["build","builds",bq.slots]].forEach(function(P){
   var run=bq.running.filter(function(b){return b.kind===P[0]}),wt=bq.waiting.filter(function(b){return b.kind===P[0]});
   if(!run.length&&!wt.length)return;
   var brow=run.map(function(b){return'<tr><td style="text-align:right"></td><td style="text-align:left">'+esc(b.label)+(b.mode==="full"?' [full]':'')+(b.key?' ['+esc(b.key)+']':'')+'</td><td style="text-align:left">'+esc(b.session)+'</td><td style="text-align:right">running</td><td style="text-align:right">'+qdur(b.ageSec)+'</td></tr>'}).concat(wt.map(function(b,i){return'<tr><td style="text-align:right">'+(i+1)+'</td><td style="text-align:left">'+esc(b.label)+(b.mode==="full"?' [full]':'')+(b.key?' ['+esc(b.key)+']':'')+'</td><td style="text-align:left">'+esc(b.session)+'</td><td style="text-align:right">waiting'+(b.why?' ('+esc(b.why)+')':'')+'</td><td style="text-align:right">'+qdur(b.waitedSec)+'</td></tr>'}));
   out.unshift(block(P[1]+' ('+P[2]+' slot'+(P[2]===1?'':'s')+')',["pos","build","session","state","age / waited"],brow));
  });
 }
 if(pl.length)out.unshift(block("plans",["plan","parts","phase","in phase","running","workers"],pl.map(function(p){return'<tr><td style="text-align:left">'+esc(p.job)+'</td><td style="text-align:right">'+p.merged+'/'+p.total+'</td><td style="text-align:left">'+esc(p.phase)+'</td><td style="text-align:right">'+qdur(p.phaseSec)+'</td><td style="text-align:right">'+qdur(p.ageSec)+'</td><td style="text-align:left">'+esc((p.running||[]).join(", "))+'</td></tr>'})));
 var pv=q.paneViolations||[];
 if(pv.length)out.unshift(block("pane violations",["process","mark","why"],pv.map(function(p){return'<tr style="color:#d33"><td style="text-align:left">'+esc(p.id)+'</td><td style="text-align:left">'+esc(p.mark)+'</td><td style="text-align:left">'+esc(p.why||"")+'</td></tr>'})));
 var pn=q.panes||[];
 if(pn.length)out.unshift(block("panes",["label","cwd","running","log"],pn.map(function(p){return'<tr><td style="text-align:left">'+esc(p.label)+'</td><td style="text-align:left">'+esc(p.cwd)+'</td><td style="text-align:right">'+qdur(p.ageSec)+'</td><td style="text-align:left">'+esc(p.log)+'</td></tr>'})));
 if(q.localModel)out.unshift('<div style="margin:4px 0;color:#888">'+esc(q.localModel)+"</div>");
 el.innerHTML=out.join("")+wt;
 function post(verb,body){
  fetch("/cockpit/queue/"+verb,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),cache:"no-store"})
   .then(function(r){return r.json()}).then(function(j){if(j.error)setTip($("queuetip"),j.error);loadQueue()}).catch(function(){loadQueue()});
 }
 var bs=el.querySelectorAll("button[data-q]");
 for(var i=0;i<bs.length;i++)bs[i].onclick=function(){this.disabled=true;post(this.getAttribute("data-q"),{id:this.getAttribute("data-id")})};
 var rs=el.querySelectorAll("tr.qrow"),from=null;
 for(var k=0;k<rs.length;k++){(function(tr){
  tr.ondragstart=function(e){qdrag=true;from=tr;tr.style.opacity=".4";if(e.dataTransfer){e.dataTransfer.effectAllowed="move";try{e.dataTransfer.setData("text/plain",tr.getAttribute("data-id"))}catch(x){}}};
  tr.ondragover=function(e){if(from&&from.getAttribute("data-prov")===tr.getAttribute("data-prov")){e.preventDefault();tr.style.outline="1px solid var(--acc)"}};
  tr.ondragleave=function(){tr.style.outline=""};
  tr.ondrop=function(e){e.preventDefault();tr.style.outline="";if(!from||from===tr||from.getAttribute("data-prov")!==tr.getAttribute("data-prov"))return;post("move",{id:from.getAttribute("data-id"),position:Number(tr.getAttribute("data-pos"))})};
  tr.ondragend=function(){from=null;qdrag=false;tr.style.opacity="";loadQueue()};
 })(rs[k])}
}
function loadQueue(){fetch("/cockpit/queue",{cache:"no-store"}).then(function(r){return r.json()}).then(renderQueue).catch(function(){})}
function loadModels(){fetch("/cockpit/models",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){mdl=j;renderLimits();renderModels()}).catch(function(){})}
function loadLimits(){fetch("/cockpit/limits",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){lim=j;renderLimits();if(sys)renderSystem();renderDonuts()}).catch(function(){})}
function tabs(){var b=document.querySelectorAll("#tabs button");for(var i=0;i<b.length;i++){b[i].className=b[i].getAttribute("data-w")===win?"on":"";b[i].onclick=function(){win=this.getAttribute("data-w");localStorage.setItem("cockpitWin",win);tabs();load();loadSystem()}}}
/** Theme: the system's until the user picks one (only a click is saved); the button shows the other mode. */
function setTheme(t){document.documentElement.dataset.theme=t;var b=$("theme"),l=t==="dark"?"Light mode":"Dark mode";b.title=l;b.setAttribute("aria-label",l)}
$("theme").onclick=function(){var t=document.documentElement.dataset.theme==="dark"?"light":"dark";setTheme(t);try{localStorage.setItem("pai.cockpit.theme",t)}catch(e){}};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(e){var s=null;try{s=localStorage.getItem("pai.cockpit.theme")}catch(err){}if(!s)setTheme(e.matches?"dark":"light")});
setTheme(document.documentElement.dataset.theme==="dark"?"dark":"light");
/* a section that is not on the page fetches nothing */
var needData=has("kpis","tokens","cache","speed","pause","sessions","runs","daily"),needSys=has("system","tokens","cache","cloud"),needLim=has("cloud","models","system","cache"),needModels=has("models"),needPool=has("pool"),needQueue=has("workers");
tabs();applyCollapse();if(needData)load();if(needSys)loadSystem();if(needLim)loadLimits();if(needModels)loadModels();if(needPool)loadPool();if(needQueue)loadQueue();
if(needData&&needSys)setInterval(function(){load();loadSystem()},5000);else if(needData)setInterval(load,5000);else if(needSys)setInterval(loadSystem,5000);if(needLim)setInterval(loadLimits,30000);if(needModels)setInterval(loadModels,5000);if(needPool)setInterval(loadPool,15000);if(needQueue)setInterval(loadQueue,5000);setInterval(tick,1000);
})();
</script></body></html>
`;

/** Stable ids of the page's top-level sections, in page order (config key router.cockpit.sections). */
export const COCKPIT_SECTION_IDS = ["cloud", "workers", "pool", "models", "system", "kpis", "tokens", "cache", "speed", "pause", "sessions", "runs", "daily"] as const;

/** The full page: every section. */
export const COCKPIT_HTML = FULL_HTML;

/**
 * The page with only the listed sections, in the listed order. Unlisted sections are cut out of the
 * HTML (no DOM) and the script skips their fetches. Undefined or empty list = the full page; unknown ids are ignored
 * (all unknown = full page, so a typo never yields a blank cockpit).
 */
export function cockpitHtml(sections?: readonly string[]): string {
  const want = (sections ?? []).filter((id) => (COCKPIT_SECTION_IDS as readonly string[]).includes(id));
  if (!want.length) return FULL_HTML;
  const re = /<section data-section="([a-z]+)"[\s\S]*?<\/section>\n?/g;
  const found = new Map<string, string>();
  const [head, rest] = [FULL_HTML.slice(0, FULL_HTML.indexOf("<main>") + 7), FULL_HTML.slice(FULL_HTML.indexOf("<main>") + 7)];
  const tail = rest.slice(rest.indexOf("</main>"));
  for (const m of rest.slice(0, rest.indexOf("</main>")).matchAll(re)) found.set(m[1]!, m[0].endsWith("\n") ? m[0] : m[0] + "\n");
  return head + [...new Set(want)].map((id) => found.get(id) ?? "").join("") + tail;
}
