/** cockpit-page — script: system data and the line/bar/legend charts. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** sys state through the axis label helper. */
export const scriptCharts = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`var sys=null;
/** Chart redraw on resize: a change smaller than the slack is ignored; the redraw is debounced. */
var CHART_RESIZE_SLACK_PX=${n(L.chartResizeSlackPx)},CHART_RESIZE_DEBOUNCE_MS=${n(L.chartResizeDebounceMs)},chartTimer=null;
/** 4th column: 0 = watts on the left axis (auto), 1 = percent on the fixed 0-100 right axis. */
var PKEYS=[["totalW","power W","#d98a1c",0],["gpu","GPU load","#3b6fe0",1],["cpu","CPU load","#2e9e5b",1]];
/* one helper for every GB on the page: binary GB (1024^3), the same rounding as
 * Strata's monitor (serve/web/app.js line 13): 1 decimal for a used value, 0 for a total */
function gb(b,d){return b==null?"n/a":(b/1073741824).toFixed(d==null?1:d)}
/** GB from MB values (the inventory's memoryMb / mappedMb / rssMb): the same binary GB, 1 decimal. */
function gbm(m){return m==null?"–":(m/1024).toFixed(1)}
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
 // the unit sits next to the value, not only in the caption
 var kpis=[
  ["memory",c.memUsed!=null?gb(c.memUsed)+" GB":na(null),"of "+na(c.memTotal!=null?gb(c.memTotal)+" GB":null)+" · pressure "+(c.pressureLevel!=null?(100-c.pressureLevel)+"%":na(null))],
  ["swap",c.swapUsed!=null?gb(c.swapUsed)+" GB":na(null),"of "+na(c.swapTotal!=null?gb(c.swapTotal)+" GB":null)],
  ["wired",c.wired!=null?gb(c.wired)+" GB":na(null),"vm_stat"],
  ["compressed",c.compressed!=null?gb(c.compressed)+" GB":na(null),"vm_stat"],
  ["CPU load",val("cpu",pctf),"all clusters"],
  ["GPU load",val("gpu",pctf),(freq?(freq/1000).toFixed(1)+" GHz":"IOReport")+tag()],
  ["ANE load",val("ane",pctf),"neural engine"+tag(),"ane"],
  ["SoC temp",val("socTemp",function(v){return v.toFixed(1)+" °C"}),"IOReport"+tag()],
  ["CPU W",val("cpuW",function(v){return w1(v)+" W"}),"CPU rail"+tag(),"cpuW"],
  ["GPU W",val("gpuW",function(v){return w1(v)+" W"}),"GPU rail"+tag(),"gpuW"],
  ["ANE W",val("aneW",function(v){return w1(v)+" W"}),"neural engine"+tag(),"aneW"],
  ["system W",val("systemW",function(v){return w1(v)+" W"}),"system rail"+tag()],
  ["power",val("totalW",function(v){return w1(v)+" W"}),"SoC total"+tag()],
  ["energy "+win,wh+" Wh",cov+" min of 1-min samples"]
 ];
 var hid=[],ss=(sys.series&&sys.series.series)||[];
 /** Unused metric: the window has samples for it and every one is 0 (no samples = unknown, stays visible). */
 function unused(key){var n=0;for(var i=0;i<ss.length;i++){var v=ss[i][key];if(v==null)continue;if(v!==0)return false;n++}return n>0&&!(c[key]>0)}
 kpis=kpis.filter(function(k){if(k[3]&&unused(k[3])){hid.push(k[0]);return false}return true});
 setHtml($("sys"),kpis.map(function(k){return'<div class="kpi"><b>'+k[1]+'</b><span>'+esc(k[0])+'</span><span style="display:block;color:var(--dim)">'+k[2]+'</span></div>'}).join("")+(hid.length?'<div class="dim" style="flex-basis:100%;font-size:11px" title="Every sample in the selected window reads 0 for these; they reappear as soon as a non-zero reading arrives.">hidden: '+esc(hid.join(", "))+' (0 in this window)</div>':""));
 var allSrv=sys.servers||[];
 var srv=allSrv.filter(function(s){return s.up!==false});
 function dec(p){var r=((data&&data.speed)||[]).filter(function(x){return x.provider===p&&(x.h1.writeTps!=null||x.h24.writeTps!=null)})[0];if(!r)return'<span class="dim">-</span>';return fmt(r.h1.writeTps!=null?r.h1.writeTps:r.h24.writeTps)}
setHtml($("sysservers"),srv.length?table(["local server","status","RSS","end-to-end tok/s","decode tok/s","prefix cache"],srv.map(function(s){return[esc(s.provider),'<span class="'+(s.up?"ok":"bad")+'">'+(s.up?"up":"down")+'</span>',s.rssMb!=null?gbm(s.rssMb)+" GB":'<span class="dim">n/a</span>',s.tokensPerSec!=null?s.tokensPerSec:'<span class="dim">-</span>',dec(s.provider),s.prefixCache?pct(s.prefixCache.hitRate)+" ("+s.prefixCache.hits+"/"+(s.prefixCache.hits+s.prefixCache.misses)+")":lim?'<span class="dim">not reported</span>':'<span class="dim" title="loading: first limits poll pending">…</span>']})):'<span class="dim">'+(allSrv.length?"all local model servers down":"no local model servers configured")+'</span>');
 renderDonuts();
}
function trimEmpty(labels,rows,totalOf){
 var a=0,b=rows.length-1;
 while(a<=b&&!totalOf(rows[a]))a++;
 while(b>=a&&!totalOf(rows[b]))b--;
 return a>b?null:{labels:labels.slice(a,b+1),rows:rows.slice(a,b+1)}
}
/** The svg wrapper: the viewBox is the container's real pixel box (chartW), so every
 *  user unit is one CSS px and svg text renders at its CSS font-size whatever the chart width. */
function chartSvg(el,w,h){return'<svg width="100%" viewBox="0 0 '+chartW(el,w)+' '+h+'" preserveAspectRatio="xMidYMid meet">'}
/** The width a chart draws at: the container's real pixel width (clientWidth), else the
 *  configured fallback. The viewBox uses it directly — no scaling of text with chart width.
 *  Also stamps el.__cw: the width the current svg was drawn at (the resize check). */
function chartW(el,fallback){var w=el&&el.clientWidth;var cw=w>0?Math.round(w):fallback;if(el)el.__cw=cw;return cw}
function emptyChart(el,w,h){
 var padL=padFor([fmtAxis(1e9)]),padB=18,padT=6,cw=chartW(el,w),W=cw-padL-6,H=h-padB-padT,svg=chartSvg(el,w,h);
 for(var g=0;g<=3;g++){var yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(cw-6)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/>'}
 svg+='<text x="'+(padL+W/2)+'" y="'+(padT+H/2+3)+'" text-anchor="middle">no data in this window</text>';
 return svg+'</svg>';
}
function lineChart(el,labels,series,keys,w,h){
 var tr=trimEmpty(labels,series,function(s){var t=0;keys.forEach(function(k){t+=s[k[0]]||0});return t});
 if(!tr){setHtml(el,emptyChart(el,w,h));return}
 labels=tr.labels;series=tr.rows;
 var cw=chartW(el,w),padL=44,padR=34,padB=18,padT=6,W=cw-padL-padR,H=h-padB-padT,n=labels.length,bw=W/n;
 var leftMax=1,hasR=false; // key[3]: 1 = percent, fixed 0-100 right axis; others share the auto left axis
 keys.forEach(function(k){if(k[3])hasR=true;else series.forEach(function(s){if((s[k[0]]||0)>leftMax)leftMax=s[k[0]]})});
 padL=padFor([fmtAxis(leftMax)+" W"]);
 var PCT=["0","33","66","100"],svg=chartSvg(el,w,h);
 for(var g=0;g<=3;g++){var yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(cw-padR)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(padL-4)+'" y="'+(yy+3)+'" text-anchor="end">'+fmtAxis(leftMax*g/3)+' W</text>'+
  (hasR?'<text x="'+(cw-2)+'" y="'+(yy+3)+'" text-anchor="end">'+PCT[g]+'%</text>':'')}
 keys.forEach(function(k){
  var scale=k[3]?100:leftMax,d="",pen=false;
  series.forEach(function(s,i){var v=s[k[0]];if(v==null){pen=false;return}
   var x=padL+i*bw+bw/2,y=padT+H-(v/scale)*H;d+=(pen?"L":"M")+x.toFixed(1)+' '+y.toFixed(1);pen=true});
  if(d)svg+='<path d="'+d+'" fill="none" stroke="'+k[2]+'" stroke-width="1.5"/>';
 });
 series.forEach(function(s,i){if(n<=30||i%Math.ceil(n/12)===0)svg+='<text x="'+(padL+i*bw+bw/2)+'" y="'+(h-4)+'" text-anchor="middle">'+esc(labels[i])+'</text>'});
 setHtml(el,svg+'</svg>');
}
function renderPower(){
 if(!sys||!sys.series)return;
 var ss=sys.series.series;
 lineChart($("power"),ss.map(function(b){return label(b.t,sys.window)}),ss,PKEYS,${L.powerChartWidthPx},${L.powerChartHeightPx});
 setHtml($("plegend"),PKEYS.map(function(k){return'<span><i style="background:'+k[2]+'"></i>'+esc(k[1])+'</span>'}).join(""));
}
function tick(){
 var els=document.querySelectorAll("[data-reset]");
 for(var i=0;i<els.length;i++){var r=+els[i].getAttribute("data-reset");if(r)els[i].textContent="resets in "+dur(r-Date.now())}
 var st=$("stamp");
 // every poll marks itself ok; the stamp reads offline only when all polls fail
 var age=(Date.now()-lastOk)/1000;
 st.textContent=lastOk?(age<STALE_SEC?"live · ":"stale "+Math.round(age)+"s · ")+new Date(lastOk).toLocaleTimeString():"offline";
 st.title=st.textContent;st.className=lastOk&&age>=STALE_SEC?"stale":"";
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
 var cw=chartW(el,w),padB=18,padT=6,max=1;
 var sums=series.map(function(s){var t=0;keys.forEach(function(k){t+=s[k]||0});return t});sums.forEach(function(v){if(v>max)max=v});
 var padL=padFor([fmtAxis(max)]),H=h-padB-padT;
 var L=gapLayout(sums,cw,padL),svg=chartSvg(el,w,h);
 for(var g=0;g<=3;g++){var yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(cw-6)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(padL-4)+'" y="'+(yy+3)+'" text-anchor="end">'+fmtAxis(max*g/3)+'</text>'}
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
 setHtml(el,svg+'</svg>');
 return L.compressed;
}
function twoToneModelBars(el,labels,buckets,models,w,h){
 var cw=chartW(el,w),padB=18,padT=6,mc=models.length,max=1;
 models.forEach(function(m){colorOf(m)});
 var totals=buckets.map(function(arr){var t=0;arr.forEach(function(s){t+=s.total});return t});totals.forEach(function(v){if(v>max)max=v});
 var padL=padFor([fmtAxis(max)]),W=cw-padL-6,H=h-padB-padT;
 var L=gapLayout(totals,cw,padL),mwid=mc?Math.max(3,L.bw/mc):L.bw,svg=chartSvg(el,w,h);
 for(var g=0;g<=3;g++){var yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(cw-6)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(padL-4)+'" y="'+(yy+3)+'" text-anchor="end">'+fmtAxis(max*g/3)+'</text>'}
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
 setHtml(el,svg+'</svg>');
 return L.compressed;
}
function legend(el,keys,extra){setHtml(el,keys.map(function(k){return'<span><i style="background:'+colorOf(k)+'"></i>'+esc(k)+'</span>'}).join("")+(extra||""))}
/** One legend line: a small caption, then the swatch items. */
function legendLine(cap,items){return'<div class="lgline"><span class="lgcap">'+esc(cap)+'</span>'+items+'</div>'}
/** The chart caption under the svg: set only when idle buckets were compressed. */
function chartCap(el,on){setHtml(el,on?'<div class="cap dim">idle hours compressed: the x axis is not time-linear</div>':"")}
/** The chart containers and their redraw entry points (set by render/renderPower). */
var CHARTS=[["series","render"],["daily","render"],["power","renderPower"]];
/** Resize: a chart redraws only when its container's pixel width changed by more than
 *  CHART_RESIZE_SLACK_PX — the viewBox equals the container width, so text stays 10 px at
 *  any width; a redraw re-measures it. Debounced; falls back to the resize event. */
function chartResize(){
 if(chartTimer)clearTimeout(chartTimer);
 chartTimer=setTimeout(function(){
  chartTimer=null;
  CHARTS.forEach(function(c){
   var el=$(c[0]),w=el.clientWidth||0;
   if(w>0&&Math.abs(w-(el.__cw||0))>CHART_RESIZE_SLACK_PX&&typeof window!=="undefined"&&window[c[1]])window[c[1]]();
  });
 },CHART_RESIZE_DEBOUNCE_MS);
}
function label(t,win){var d=new Date(t);return win==="7d"?d.toLocaleDateString([],{weekday:"short"}):win==="24h"?String(d.getHours()).padStart(2,"0")+"h":d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
`;
