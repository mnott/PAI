/** cockpit-page — script core: colours, setHtml and formatters, fitTables. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** Script opening: the shared state and helpers the window runtime draws with. */
export const scriptCore = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`var KINDS=[["input","fresh input","#3b6fe0"],["cacheWrite","cache write","#e0703b"],["cacheRead","cache read","#2e9e5b"],["output","output","#b04fd0"]],mode=localStorage.getItem("cockpitMode")||"weighted",msel="";var win=localStorage.getItem("cockpitWin")||"1h",DAILY_DAYS=${n(L.dailyDays)},SESSION_ROWS=${n(L.sessionsRows)},WORKER_ROWS=${n(L.workerRows)},LOW_REQ=${n(L.lowRequestMin)},STALE_SEC=${n(L.stampStaleSecs)},COLOR_PRUNE_DAYS=${n(L.colorPruneDays)},data=null,lim=null,lastOk=0,PAL=[${L.palette.map(hex).join(",")}];
var colors={},CKEY="pai.cockpit.modelColors.v1";
try{colors=JSON.parse(localStorage.getItem(CKEY)||"{}")||{}}catch(e){colors={}}
function saveColors(){try{localStorage.setItem(CKEY,JSON.stringify(colors))}catch(e){}}
/** Model colours: one colour per model across the whole page. assignColors is called once per render
 *  with the UNION of every model shown anywhere (window models, daily models, rings, speed table), so
 *  a chart that shows fewer models never wipes another chart's colours. A model keeps the colour saved
 *  under its name (localStorage); a new one takes the first palette entry no model uses, in sorted-name
 *  order — so the assignment does not depend on the data's order. Past the palette, extra models get
 *  generated colours (HSL hues rotated away from the hues in use). Saved entries older than
 *  COLOR_PRUNE_DAYS (router.cockpit.layout.colorPruneDays) are pruned by their "@ts" stamp; a model
 *  that is merely not visible right now keeps its colour. */
function assignColors(ms){
 var want={},i,k;for(i=0;i<ms.length;i++)want[ms[i]]=1;
 var names=Object.keys(want).sort(),taken={},n=new Date().getTime();
 // a saved colour counts as taken even when its model is not in this list — that is what keeps
 // a chart with a smaller model set from reusing another chart's colour
 for(k in colors)if(String(k).indexOf("@ts")<0&&/^#[0-9a-f]{6}$/i.test(String(colors[k]))&&!(colors[k] in taken))taken[colors[k]]=k;
 var changed=false;
 for(i=0;i<names.length;i++){
  var nm=names[i],c=colors[nm],p=0;
  if(c&&/^#[0-9a-f]{6}$/i.test(String(c))&&taken[c]===nm)continue;
  while(p<PAL.length&&taken[PAL[p]]!==undefined)p++;
  if(p<PAL.length)c=PAL[p];else c=genColor(taken);
  taken[c]=nm;colors[nm]=c;colors[nm+"@ts"]=n;changed=true;
 }
 // prune only entries older than COLOR_PRUNE_DAYS (the "@ts" stamp), never a model that is merely not visible now
 var cut=n-COLOR_PRUNE_DAYS*864e5;
 for(k in colors)if(String(k).indexOf("@ts")>=0&&+colors[k]<cut)delete colors[String(k).slice(0,String(k).indexOf("@ts"))];
 if(changed)saveColors();
}
/** "#rrggbb" of an HSL colour, lightness/saturation kept in the readable band of the palette. */
function hslHex(h,s,l){
 h=((h%360)+360)%360;s=Math.max(0,Math.min(1,s));l=Math.max(0,Math.min(1,l));
 var c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2,r=0,g=0,b=0;
 if(h<60){r=c;g=x}else if(h<120){r=x;g=c}else if(h<180){g=c;b=x}else if(h<240){g=x;b=c}else if(h<300){r=x;b=c}else{r=c;b=x}
 function hx(v){var s2=Math.round((v+m)*255).toString(16);return s2.length<2?"0"+s2:s2}
 return"#"+hx(r)+hx(g)+hx(b);
}
/** A colour for a model past the palette: rotate the hue from a golden-angle start, skipping hues
 *  within 12° of one already taken; lightness alternates so repeats stay distinguishable. */
function genColor(taken){
 var used=[],k;for(k in taken)if(/^#[0-9a-f]{6}$/i.test(k))used.push(hueOf(k)); // taken maps colour -> model name: the keys are the colours
 for(var j=0;j<720;j++){
  var h=(j*137.508+24)%360,l=j%2?0.42:0.62,ok=true;
  for(var i=0;i<used.length;i++){var d=Math.abs(h-used[i]);if(Math.min(d,360-d)<12){ok=false;break}}
  if(ok)return hslHex(h,0.55,l);
 }
 return hslHex(0,0.55,0.5);
}
/** Hue (degrees) of a #rrggbb colour. */
function hueOf(hex){
 var r=parseInt(hex.slice(1,3),16)/255,g=parseInt(hex.slice(3,5),16)/255,b=parseInt(hex.slice(5,7),16)/255;
 var mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn,h=0;
 if(d){if(mx===r)h=((g-b)/d)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4}
 return h*60;
}
/** The colour of a model: never a silent PAL[0] fallback — an unassigned model is assigned on the spot
 *  (the next free palette entry, else a generated colour) and saved. */
function colorOf(k){
 for(var i=0;i<KINDS.length;i++)if(KINDS[i][0]===k)return KINDS[i][2];
 var c=colors[k];
 if(c&&/^#[0-9a-f]{6}$/i.test(String(c)))return c;
 var taken={},nm;for(nm in colors)if(String(nm).indexOf("@ts")<0&&colors[nm])taken[colors[nm]]=nm;
 var p=0;while(p<PAL.length&&taken[PAL[p]]!==undefined)p++;
 c=p<PAL.length?PAL[p]:genColor(taken);
 colors[k]=c;colors[k+"@ts"]=new Date().getTime();saveColors();
 return c;
}
function $(id){return document.getElementById(id)||document.createElement("div")}
/** A table stacks into cards only when it does not fit as a table: lay every .tw out unstacked,
 *  stack the ones whose table is wider than the box. Measuring unstacked first keeps it from oscillating. */
function fitTables(root){
 root=root||document;if(!root.querySelectorAll)return;
 var ws=root.querySelectorAll(".tw"),i,w,t;
 for(i=0;i<ws.length;i++)ws[i].classList.remove("stacked");
 for(i=0;i<ws.length;i++){w=ws[i];t=w.querySelector("table");if(t&&(t.scrollWidth>w.clientWidth||w.scrollWidth>w.clientWidth))w.classList.add("stacked")}
}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function fmt(n){n=n||0;if(n>=1e9)return(n/1e9).toFixed(2)+"G";if(n>=1e6)return(n/1e6).toFixed(2)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return String(Math.round(n))}
/** Axis labels: one significant decimal, compact (784M, 1.57G, not 783.98M). */
function fmtAxis(n){n=n||0;if(n>=1e9)return(n/1e9>=10?(n/1e9).toFixed(0):(n/1e9).toFixed(2))+"G";if(n>=1e6)return(n/1e6>=10?(n/1e6).toFixed(0):(n/1e6).toFixed(2))+"M";if(n>=1e3)return(n/1e3>=10?(n/1e3).toFixed(0):(n/1e3).toFixed(1))+"k";return String(Math.round(n))}
/** Left padding for axis labels: the widest label at ~8 px per character (svg text is 10 px), plus the 4 px gap. */
function padFor(labels){var m=0;labels.forEach(function(s){if(String(s).length>m)m=String(s).length});return Math.max(30,m*8+12)}
function pct(x){return(x*100).toFixed(1)+"%"}
function tot(t){return t.input+t.output+t.cacheWrite+t.cacheRead}
function dur(ms){if(ms<=0)return"now";var s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+"d "+h+"h":h?h+"h "+String(m).padStart(2,"0")+"m":m+"m "+String(s%60).padStart(2,"0")+"s"}
function ago(iso){var s=(Date.now()-Date.parse(iso))/1000;return s<90?Math.round(s)+"s":s<5400?Math.round(s/60)+"m":s<172800?Math.round(s/3600)+"h":Math.round(s/86400)+"d"}
/** A limits gauge: red at/above GAUGE_BAD_PCT, amber at/above GAUGE_WARN_PCT (router.cockpit.layout). */
function sev(p){return p>=${n(L.gaugeBadPct)}?"var(--bad)":p>=${n(L.gaugeWarnPct)}?"var(--warn)":"var(--ok)"}
/* metricTile: ported from Strata's "Speed" metric tile (MIT, Copyright (c) 2026 Niko1221 and the Strata contributors) */
function metricSpark(series){
 var max=0,n=0,i,d;
 series.forEach(function(x){(x.data||[]).forEach(function(v){if(v!=null&&isFinite(v)&&v>max)max=v});n=Math.max(n,(x.data||[]).length)});
 if(!max)max=1;
 return series.map(function(x,k){
  d=x.data||[];var line="",area="",seg=[];
  // a missing (null) point is interpolated linearly between its neighbours, so a
  // series with data draws one continuous line; leading/trailing nulls are dropped
  var a=0,b=d.length-1;while(a<=b&&!(d[a]!=null&&isFinite(d[a])))a++;while(b>=a&&!(d[b]!=null&&isFinite(d[b])))b--;
  function valAt(j){
   if(d[j]!=null&&isFinite(d[j]))return d[j];
   var p=j,q=j;
   while(p>a&&!(d[p]!=null&&isFinite(d[p])))p--;
   while(q<b&&!(d[q]!=null&&isFinite(d[q])))q++;
   return d[p]+(d[q]-d[p])*(j-p)/(q-p);
  }
  for(i=a;i<=b;i++){
   seg.push((n>1?i/(n-1)*${L.sparkViewMaxPx}:50).toFixed(1)+","+(${L.sparkPlotTopPx}-valAt(i)/max*${L.sparkPlotHeightPx}).toFixed(1));
  }
  if(seg.length){line+="M"+seg.join("L");if(seg.length>1&&k===0)area+="M"+seg[0].split(",")[0]+",${L.sparkHeightPx}L"+seg.join("L")+"L"+seg[seg.length-1].split(",")[0]+",${L.sparkHeightPx}Z"}
  return(area?'<path class="area" fill="currentColor" opacity=".12" d="'+area+'"/>':"")+(line?'<path class="line mt-'+esc(x.tone||(k?"alt":"acc"))+'" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" d="'+line+'"/>':"")
 }).join("");
}
/** Baked policy values, declared before the helpers that use them so each extracted function stays self-contained. */
var JOB_TRIES=${n(L.jobMaxTries)},JOB_POLL=${n(L.jobPollMs)},SRV_STALE_SEC=${n(L.serverCounterStaleSecs)};
/** Colour thresholds (router.cockpit.layout.thresholds): a hit ratio below HIT_WARN reads amber,
 *  below HIT_BAD red; an error rate at/above ERROR_WARN amber, at/above ERROR_BAD red. */
var HIT_WARN=${n(L.hitWarn)},HIT_BAD=${n(L.hitBad)},ERROR_WARN=${n(L.errorWarn)},ERROR_BAD=${n(L.errorBad)};
/** Colour class of a ratio: red at/above bad, amber at/above warn, else plain. */
function cls(v,warn,bad){return v>=bad?"bad":v>=warn?"warn":""}
/** Colour class of a hit ratio (the rings, the pause table, the sessions table):
 *  red below HIT_BAD, amber below HIT_WARN, else ok. */
function hitCls(r){return r<HIT_BAD?"bad":r<HIT_WARN?"warn":"ok"}
`;
