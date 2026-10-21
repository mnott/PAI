/** cockpit-page — script: system data and the line/bar/legend charts. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** sys state through the axis label helper. */
export const scriptCharts = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`var sys=null;
/** Chart redraw on resize: a change smaller than the slack is ignored; the redraw is debounced. */
var CHART_RESIZE_SLACK_PX=${n(L.chartResizeSlackPx)},CHART_RESIZE_DEBOUNCE_MS=${n(L.chartResizeDebounceMs)},chartTimer=null,MIN_LABEL_GAP_PX=${n(L.minLabelGapPx)},MIN_BAR_PX=${n(L.minBarPx)};
/** 4th column: 0 = watts on the left axis (auto), 1 = percent on the fixed 0-100 right axis. */
var PKEYS=[["totalW","power W","#d98a1c",0],["gpu","GPU load","#3b6fe0",1],["cpu","CPU load","#2e9e5b",1]];
/* one helper for every GB on the page: binary GB (1024^3), the same rounding as
 * Strata's monitor (serve/web/app.js line 13): 1 decimal for a used value, 0 for a total */
function gb(b,d){return b==null?"n/a":(b/1073741824).toFixed(d==null?1:d)}
/** GB from MB values (the inventory's memoryMb / mappedMb / rssMb): the same binary GB, 1 decimal. */
function gbm(m){return m==null?"–":(m/1024).toFixed(1)}
/** Last good readings per metric: a stale source keeps its number on the tile instead of n/a. */
var LAST={};
/** Client-side history per tile: the last SYS_HIST_LEN polls, for the metrics the server does not keep a series of. */
var SYSH={},SYS_HIST_LEN=${n(L.sysHistoryLen)};
/** Age of a remembered reading, as the short text the tile's sub line shows. */
function staleAge(m,now){var s=Math.max(0,(now-m.at)/1000);return s<90?Math.round(s)+"s":s<3600?Math.round(s/60)+"m":Math.round(s/3600)+"h"}
function ringPush(k,v){var a=SYSH[k]||(SYSH[k]=[]);a.push(v==null?null:v);if(a.length>SYS_HIST_LEN)a.shift();return a}
function renderSystem(){
 if(!sys)return;var c=sys.current||{};
 var tip=(sys.unavailable&&sys.unavailable.all)?sys.unavailable.all:((c.notes||[]).join("; ")||("source: "+(c.source||"none")));
 var ss=(sys.series&&sys.series.series)||[];
 var fresh=!sys.__h;sys.__h=1; // the history rings grow once per poll payload, not per redraw
 /** Sparkline data: the server's series for the window when it has one, else the ring of the last polls. */
 function hist(key,sk,v){
  if(sk){var a=ss.map(function(b){return b[sk]});if(a.filter(function(x){return x!=null}).length>1)return a}
  return fresh?ringPush(key,v):(SYSH[key]||[])
 }
 /** A fresh reading, or the last good one (marked with its age) when the payload dropped it. */
 function rd(key){
  var v=c[key];
  if(v!=null){LAST[key]={v:v,at:Date.now()};return{v:v,age:""}}
  var m=LAST[key];return m?{v:m.v,age:staleAge(m,Date.now())}:{v:null,age:""}
 }
 function pctf(v){return String(Math.round(v))}
 function w1(v){return v.toFixed(1)}
 var slowAge=sys.slowAgeS; // mactop probe (gpu/temp/power) rides the 1-min ring; say how old it is
 function tag(){return slowAge==null?"":" · "+(slowAge<90?"probe "+slowAge+"s":"cached "+(slowAge<3600?Math.round(slowAge/60)+" min":Math.round(slowAge/3600)+" h"))}
 var freq=c.gpuFreqMhz; // GPU clock for the load sublabel, remembered like the other probe values
 if(freq==null&&LAST.gpuFreqMhz)freq=LAST.gpuFreqMhz.v;else if(freq!=null)LAST.gpuFreqMhz={v:freq,at:Date.now()};
 var wh=(sys.series&&sys.series.wh&&sys.series.wh[win])||0,cov=(sys.series&&sys.series.coveredMin&&sys.series.coveredMin[win])||0;
 /** One metric tile: value with its unit, a sub line, the history sparkline. sk = the key of the server series. */
 function T(title,key,fmtv,unit,sub,sk){
  var r=rd(key);
  return metricTile({title:title,value:r.v==null?null:fmtv(r.v),unit:unit,sub:(r.age?"~"+r.age+" old · ":"")+(r.v==null?tip:sub),series:[{data:hist(key,sk,r.v)}]})
 }
 function of(v){return"of "+(v!=null?gb(v,0)+" GB":"n/a")}
 var tiles=[
  [null,null,function(){return T("memory","memUsed",gb,"GB",of(c.memTotal)+" · pressure "+(c.pressureLevel!=null?(100-c.pressureLevel)+"%":"n/a"),"memPct")}],
  [null,null,function(){return T("swap","swapUsed",gb,"GB",of(c.swapTotal))}],
  [null,null,function(){return T("wired","wired",gb,"GB","vm_stat")}],
  [null,null,function(){return T("compressed","compressed",gb,"GB","vm_stat")}],
  [null,null,function(){return T("CPU load","cpu",pctf,"%","all clusters","cpu")}],
  [null,null,function(){return T("GPU load","gpu",pctf,"%",(freq?(freq/1000).toFixed(1)+" GHz":"IOReport")+tag(),"gpu")}],
  ["ane","ANE load",function(){return T("ANE load","ane",pctf,"%","neural engine"+tag(),"ane")}],
  [null,null,function(){return T("SoC temp","socTemp",w1,"°C","IOReport"+tag(),"socTemp")}],
  ["cpuW","CPU W",function(){return T("CPU W","cpuW",w1,"W","CPU rail"+tag(),"cpuW")}],
  ["gpuW","GPU W",function(){return T("GPU W","gpuW",w1,"W","GPU rail"+tag(),"gpuW")}],
  ["aneW","ANE W",function(){return T("ANE W","aneW",w1,"W","neural engine"+tag(),"aneW")}],
  [null,null,function(){return T("system W","systemW",w1,"W","system rail"+tag(),"systemW")}],
  [null,null,function(){return T("power","totalW",w1,"W","SoC total"+tag(),"totalW")}],
  [null,null,function(){return metricTile({title:"energy "+win,value:String(wh),unit:"Wh",sub:cov+" min of 1-min samples",series:[{data:hist("wh"+win,null,wh)}]})}]
 ];
 var hid=[];
 /** Unused metric: the window has samples for it and every one is 0 (no samples = unknown, stays visible). */
 function unused(key){var n=0;for(var i=0;i<ss.length;i++){var v=ss[i][key];if(v==null)continue;if(v!==0)return false;n++}return n>0&&!(c[key]>0)}
 var out=[];
 tiles.forEach(function(t){if(t[0]&&unused(t[0])){hid.push(t[1]);return}out.push(t[2]())});
 var sysEl=$("sys");
 setHtml(sysEl,'<div class="rt-tiles" data-tkey="sys">'+out.join("")+'</div>');
 setHtml($("syshid"),hid.length?'<div class="dim" style="font-size:11px;margin-top:6px" title="Every sample in the selected window reads 0 for these; they reappear as soon as a non-zero reading arrives.">hidden: '+esc(hid.join(", "))+' (0 in this window)</div>':"");
 var allSrv=sys.servers||[];
 var srv=allSrv.filter(function(s){return s.up!==false});
 function dec(p){var r=((data&&data.speed)||[]).filter(function(x){return x.provider===p&&(x.h1.writeTps!=null||x.h24.writeTps!=null)})[0];return r?(r.h1.writeTps!=null?r.h1.writeTps:r.h24.writeTps):null}
 /** A local server tile; the history is the client ring of the last polls. */
 function S(s,what,v,txt,unit,sub){return metricTile({title:s.provider+" "+what,value:v==null?null:txt(v),unit:unit,sub:sub,series:[{data:hist("srv:"+s.provider+":"+what,null,v)}]})}
 setHtml($("sysservers"),srv.length?'<div class="rt-tiles" data-tkey="syssrv">'+srv.map(function(s){
  var pc=s.prefixCache,tot=pc?pc.hits+pc.misses:0;
  return S(s,"RSS",s.rssMb,gbm,"GB","resident memory")+S(s,"end-to-end",s.tokensPerSec,String,"tok/s","end to end")+S(s,"decode",dec(s.provider),fmt,"tok/s","decode")+S(s,"prefix cache",pc?pc.hitRate:null,function(v){return(v*100).toFixed(1)},"%",pc?pc.hits+"/"+tot:lim?"not reported":"loading: first limits poll pending")
 }).join("")+'</div>':'<span class="dim">'+(allSrv.length?"all local model servers down":"no local model servers configured")+'</span>');
 // the poll rebuild must not reset the tile order the user arranged
 orderTiles($("sys"));orderTiles($("sysservers"));
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
 var lstep=labelStep(bw);
 series.forEach(function(s,i){if(i%lstep===0)svg+='<text x="'+(padL+i*bw+bw/2)+'" y="'+(h-4)+'" text-anchor="middle">'+esc(labels[i])+'</text>'});
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
/** Time-axis labels: one every k buckets so neighbouring labels keep MIN_LABEL_GAP_PX between their centres. */
function labelStep(pitch){return Math.max(1,Math.ceil(MIN_LABEL_GAP_PX/Math.max(pitch,0.01)))}
/** Buckets merged into one column: the smallest f whose columns leave every one of the per bars at least MIN_BAR_PX wide. */
function mergeFactor(n,w,per){var f=1;while(f<n&&(w/Math.ceil(n/f))/per-2<MIN_BAR_PX)f++;return f}
/** Groups of f consecutive items; the group's label is its first. */
function mergeLabels(labels,f){var o=[];for(var i=0;i<labels.length;i+=f)o.push(labels[i]);return o}
function mergeSeries(series,keys,f){var o=[];for(var i=0;i<series.length;i+=f){var m={};keys.forEach(function(k){m[k]=0});series.slice(i,i+f).forEach(function(s){keys.forEach(function(k){m[k]+=s[k]||0})});o.push(m)}return o}
function mergeModelBuckets(buckets,f){var o=[];for(var i=0;i<buckets.length;i+=f){var by={},ord=[];buckets.slice(i,i+f).forEach(function(arr){arr.forEach(function(s){var m=by[s.model];if(!m){m=by[s.model]={model:s.model,requests:0,total:0,cacheRead:0};KINDS.forEach(function(k){m[k[0]]=0});ord.push(m)}m.requests+=s.requests;m.total+=s.total;m.cacheRead+=s.cacheRead;KINDS.forEach(function(k){m[k[0]]+=s[k[0]]||0})})});o.push(ord)}return o}
/** The caption of a merged chart ("10-minute buckets"); the bucket is f times the data's own (a day for the daily chart). */
function aggCap(el,f){
 var ms=(el&&el.id==="daily"?86400000:(data&&data.bucketMs)||0)*f,m=Math.round(ms/60000);
 return m<60?m+"-minute buckets":m<1440?Math.round(m/60)+"-hour buckets":Math.round(m/1440)+"-day buckets"
}
/** Columns for the bar charts: runs of zero-total buckets collapse into one 0.4-width spacer. */
function gapCols(totals){var cols=[],i=0;while(i<totals.length){if(totals[i]>0){cols.push({b:i,g:0});i++}else{var j=i;while(j<totals.length&&!totals[j])j++;cols.push({b:i,g:j-i});i=j}}return cols}
function gapLayout(totals,w,padL){
 var cols=gapCols(totals),units=0;cols.forEach(function(c){units+=c.g?0.4:1});
 var rn=0;cols.forEach(function(c){if(!c.g)rn++});
 return{cols:cols,bw:(w-padL-6)/units,step:labelStep((w-padL-6)/units),compressed:cols.some(function(c){return c.g>0})}
}
function gapMark(x,top,bot){return'<line x1="'+x.toFixed(1)+'" x2="'+x.toFixed(1)+'" y1="'+top+'" y2="'+bot+'" stroke="var(--line)" stroke-dasharray="2 3"/>'}
function stackedBars(el,labels,series,keys,w,h,tickFmt){
 var cw=chartW(el,w),padB=18,padT=6,max=1,agg=mergeFactor(series.length,cw-44-6,1);
 if(agg>1){labels=mergeLabels(labels,agg);series=mergeSeries(series,keys,agg)}
 el.__agg=agg;
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
 return barCap(el,L.compressed,agg);
}
/** What chartCap shows: true (idle gaps compressed), a bucket-size text (merged), both joined, or false. */
function barCap(el,compressed,agg){var t=[];if(compressed)t.push("idle hours compressed: the x axis is not time-linear");if(agg>1)t.push(aggCap(el,agg));return t.length?t.join(" · "):false}
function twoToneModelBars(el,labels,buckets,models,w,h){
 var cw=chartW(el,w),padB=18,padT=6,mc=models.length,max=1,agg=mergeFactor(buckets.length,cw-44-6,Math.max(1,mc));
 if(agg>1){labels=mergeLabels(labels,agg);buckets=mergeModelBuckets(buckets,agg)}
 el.__agg=agg;
 models.forEach(function(m){colorOf(m)});
 var totals=buckets.map(function(arr){var t=0;arr.forEach(function(s){t+=s.total});return t});totals.forEach(function(v){if(v>max)max=v});
 var padL=padFor([fmtAxis(max)]),W=cw-padL-6,H=h-padB-padT;
 var L=gapLayout(totals,cw,padL),mwid=mc?L.bw/mc:L.bw,svg=chartSvg(el,w,h);
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
 return barCap(el,L.compressed,agg);
}
function legend(el,keys,extra){setHtml(el,keys.map(function(k){return'<span><i style="background:'+colorOf(k)+'"></i>'+esc(k)+'</span>'}).join("")+(extra||""))}
/** One legend line: a small caption, then the swatch items. */
function legendLine(cap,items){return'<div class="lgline"><span class="lgcap">'+esc(cap)+'</span>'+items+'</div>'}
/** The chart caption under the svg: set only when idle buckets were compressed. */
function chartCap(el,on){setHtml(el,on?'<div class="cap dim">'+(typeof on==="string"?on:"idle hours compressed: the x axis is not time-linear")+'</div>':"")}
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
