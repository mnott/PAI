/** cockpit-page — script: system data and the line/bar/legend charts. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** sys state through the axis label helper. */
export const scriptCharts = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`var sys=null;
/** Chart redraw on resize: a change smaller than the slack is ignored; the redraw is debounced. */
var MIN_LABEL_GAP_PX=${n(L.minLabelGapPx)},MIN_BAR_PX=${n(L.minBarPx)},MAX_BAR_PX=28;
/** 4th column: 0 = watts on the left axis (auto), 1 = percent on the fixed 0-100 right axis. */
var PKEYS=[["totalW","power W","#d98a1c",0],["gpu","GPU load","#3b6fe0",1],["cpu","CPU load","#2e9e5b",1],["powerInW","power in W","#8a4fd0",0],["adapterW","charger limit W","#8a8a8a",0,1],["drainW","battery discharge W","#d0443e",0]];
/* one helper for every GB on the page: binary GB (1024^3), the same rounding as
 * Strata's monitor (serve/web/app.js line 13): 1 decimal for a used value, 0 for a total */
function gb(b,d){return b==null?"n/a":(b/1073741824).toFixed(d==null?1:d)}
/** GB from MB values (the inventory's memoryMb / mappedMb / rssMb): the same binary GB, 1 decimal. */
function gbm(m){return m==null?"–":(m/1024).toFixed(1)}
/** Age of a remembered reading, as the short text the tile's sub line shows. */
function staleAge(m,now){var s=Math.max(0,(now-m.at)/1000);return s<90?Math.round(s)+"s":s<3600?Math.round(s/60)+"m":Math.round(s/3600)+"h"}
function trimEmpty(labels,rows,totalOf){
 var a=0,b=rows.length-1;
 while(a<=b&&!totalOf(rows[a]))a++;
 while(b>=a&&!totalOf(rows[b]))b--;
 return a>b?null:{labels:labels.slice(a,b+1),rows:rows.slice(a,b+1)}
}
function tick(){
 var els=document.querySelectorAll("[data-reset]");
 for(var i=0;i<els.length;i++){var r=+els[i].getAttribute("data-reset");if(r)els[i].textContent="resets in "+dur(r-Date.now())}
 var st=$("stamp");
 // every poll marks itself ok; the stamp reads offline only when all polls fail
 var age=(Date.now()-lastOk)/1000;
 st.textContent=lastOk?(age<STALE_SEC?"live · ":"stale "+Math.round(age)+"s · ")+new Date(lastOk).toLocaleTimeString():"offline";
 st.title=st.textContent;if(st.setAttribute)st.setAttribute("data-s",lastOk?new Date(lastOk).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"off");st.className=lastOk&&age>=STALE_SEC?"stale":"";
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
/** Stacked bars at an explicit pixel width cw: {html, cap, agg}. ref only names the chart for aggCap ({id:"daily"}). */
function stackedBarsSvg(ref,cw,labels,series,keys,h,head){
 var padB=18,padT=10,max=1,agg=mergeFactor(series.length,cw-44-6,1);
 if(agg>1){labels=mergeLabels(labels,agg);series=mergeSeries(series,keys,agg)}
 var sums=series.map(function(s){var t=0;keys.forEach(function(k){t+=s[k]||0});return t});sums.forEach(function(v){if(v>max)max=v});
 var padL=padFor([fmtAxis(max)]),H=h-padB-padT;
 var L=gapLayout(sums,cw,padL),svg=head;
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
 return{html:svg+'</svg>',cap:barCap(ref,L.compressed,agg),agg:agg};
}
/** What chartCap shows: true (idle gaps compressed), a bucket-size text (merged), both joined, or false. */
function barCap(el,compressed,agg){var t=[];if(compressed)t.push("idle hours compressed: the x axis is not time-linear");if(agg>1)t.push(aggCap(el,agg));return t.length?t.join(" · "):false}
/** The smallest 1/1.2/1.5/2/2.5/3/4/5/6/8/10 times a power of ten that is >= v. */
function niceCeil(v){if(!(v>0))return 1;var p=Math.pow(10,Math.floor(Math.log(v)/Math.LN10)),m=v/p,s=[1,1.2,1.5,2,2.5,3,4,5,6,8,10];for(var i=0;i<s.length;i++)if(s[i]*p>=v*(1-1e-9))return s[i]*p;return 10*p}
/** Layout of the side-by-side bars: the y max is the tallest drawn bar (rounded up), each bucket gets one slot per model with data. */
function twoToneLayout(buckets){var hi=0,slots=0;buckets.forEach(function(arr){if(arr.length>slots)slots=arr.length;arr.forEach(function(s){if(s.total>hi)hi=s.total})});return{max:niceCeil(hi),slots:slots}}
/** Two-tone per-model bars at an explicit pixel width cw: {html, cap, agg}. */
function twoToneSvg(ref,cw,labels,buckets,models,h,head){
 var padB=18,padT=10,max=1,agg=mergeFactor(buckets.length,cw-44-6,Math.max(1,twoToneLayout(buckets).slots));
 if(agg>1){labels=mergeLabels(labels,agg);buckets=mergeModelBuckets(buckets,agg)}
 models.forEach(function(m){colorOf(m)});
 var totals=buckets.map(function(arr){var t=0;arr.forEach(function(s){t+=s.total});return t});max=twoToneLayout(buckets).max;
 var padL=padFor([fmtAxis(max)]),W=cw-padL-6,H=h-padB-padT;
 var L=gapLayout(totals,cw,padL),svg=head;
 for(var g=0;g<=3;g++){var yy=padT+H-H*g/3;svg+='<line x1="'+padL+'" x2="'+(cw-6)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(padL-4)+'" y="'+(yy+3)+'" text-anchor="end">'+fmtAxis(max*g/3)+'</text>'}
 var x=padL,ri=0;
 L.cols.forEach(function(c){
  var cw=L.bw*(c.g?0.4:1);
  if(c.g)svg+=gapMark(x+cw/2,padT,padT,padT+H);
  else{var arr=buckets[c.b];
   var n=arr.length,mwid=Math.min(L.bw/n,MAX_BAR_PX),x0=x+(L.bw-mwid*n)/2;
   arr.forEach(function(s,si){
    var c2=colorOf(s.model),fresh=s.total-s.cacheRead,bx=(x0+si*mwid+1).toFixed(1),bwid=Math.max(1,mwid-2).toFixed(1);
    var tip=esc(s.model)+" · "+esc(labels[c.b])+": total "+fmt(s.total)+" · non-cached "+fmt(fresh)+" · cached "+fmt(s.cacheRead)+" — "+KINDS.map(function(k){return k[1]+" "+fmt(s[k[0]])}).join(", ")+" · "+s.requests+" req";
    svg+='<rect x="'+bx+'" y="'+(padT+H-H*s.total/max).toFixed(1)+'" width="'+bwid+'" height="'+(H*s.total/max).toFixed(1)+'" fill="'+c2+'" fill-opacity=".25"><title>'+tip+'</title></rect>';
    if(fresh>0)svg+='<rect x="'+bx+'" y="'+(padT+H-H*fresh/max).toFixed(1)+'" width="'+bwid+'" height="'+(H*fresh/max).toFixed(1)+'" fill="'+c2+'"><title>'+tip+'</title></rect>';
   });
   if(!L.step||ri%L.step===0)svg+='<text x="'+(x+cw/2).toFixed(1)+'" y="'+(h-4)+'" text-anchor="middle">'+esc(labels[c.b])+'</text>';
   ri++}
  x+=cw;
 });
 return{html:svg+'</svg>',cap:barCap(ref,L.compressed,agg),agg:agg};
}
/** One legend line: a small caption, then the swatch items. */
function legendLine(cap,items){return'<div class="lgline"><span class="lgcap">'+esc(cap)+'</span>'+items+'</div>'}
function label(t,win){var d=new Date(t);return win==="7d"?d.toLocaleDateString([],{weekday:"short"}):win==="24h"?String(d.getHours()).padStart(2,"0")+"h":d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
`;
