/** cockpit-page — script core: colours, setHtml and formatters, folds, layout rows, drag. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** Script opening through resetLayout. */
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
/** Every panel rebuild goes through here. Identical html: no DOM write. Otherwise the viewport stays put (Safari has no scroll anchoring):
 *  the first main child below the viewport top is the anchor, scrollBy corrects its drift; the old height is held until the next frame so
 *  a shorter intermediate rendering cannot collapse the page; focus inside the panel moves to the equivalent element (same data-*). */
function dataKey(e){var k=e.tagName.toLowerCase(),a=e.attributes||[];for(var i=0;i<a.length;i++)if(a[i].name.indexOf("data-")===0)k+="|"+a[i].name+"="+a[i].value;return k}
/** A table stacks into cards only when it does not fit as a table: lay every .tw out unstacked,
 *  stack the ones whose table is wider than the box. Measuring unstacked first keeps it from oscillating. */
function fitTables(root){
 root=root||document;if(!root.querySelectorAll)return;
 var ws=root.querySelectorAll(".tw"),i,w,t;
 for(i=0;i<ws.length;i++)ws[i].classList.remove("stacked");
 for(i=0;i<ws.length;i++){w=ws[i];t=w.querySelector("table");if(t&&(t.scrollWidth>w.clientWidth||w.scrollWidth>w.clientWidth))w.classList.add("stacked")}
}
function setHtml(el,html){
 if(el.__html===html)return false;
 var main=document.querySelector("main"),anchor=null,top=0,i,r,kids;
 if(main){kids=main.children;for(i=0;i<kids.length;i++){r=kids[i].getBoundingClientRect();if(r.bottom>0){anchor=kids[i];top=r.top;break}}}
 var ae=document.activeElement,fk=null,prev="";
 if(ae&&ae!==el&&el.contains&&el.contains(ae)&&ae.tagName)fk=dataKey(ae);
 var hold=el.style&&typeof el.offsetHeight==="number"&&el.offsetHeight>0;
 var held=0;
 if(hold){prev=el.style.minHeight;held=el.offsetHeight;el.style.minHeight=held+"px"}
 el.innerHTML=html;el.__html=html;fitTables(el);
 if(fk){var c=el.querySelectorAll(fk.split("|")[0]);for(i=0;i<c.length;i++)if(dataKey(c[i])===fk){c[i].focus({preventScroll:true});break}}
 if(anchor){var d=anchor.getBoundingClientRect().top-top;if(d)window.scrollBy(0,d)}
 // the release runs even when the frame never fires (headless virtual time): a pending
// rAF would leave the held min-height on the panel forever (the workers card's empty space)
 function release(){if(held&&el.style.minHeight===held+"px")el.style.minHeight=prev;held=0}
 if(hold){requestAnimationFrame(release);setTimeout(release,200)}
 return true;
}
function has(){for(var i=0;i<arguments.length;i++)if(document.querySelector('[data-section="'+arguments[i]+'"]'))return true;return false}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function fmt(n){n=n||0;if(n>=1e9)return(n/1e9).toFixed(2)+"G";if(n>=1e6)return(n/1e6).toFixed(2)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return String(Math.round(n))}
/** Axis labels: one significant decimal, compact (784M, 1.57G, not 783.98M). */
function fmtAxis(n){n=n||0;if(n>=1e9)return(n/1e9>=10?(n/1e9).toFixed(0):(n/1e9).toFixed(2))+"G";if(n>=1e6)return(n/1e6>=10?(n/1e6).toFixed(0):(n/1e6).toFixed(2))+"M";if(n>=1e3)return(n/1e3>=10?(n/1e3).toFixed(0):(n/1e3).toFixed(1))+"k";return String(Math.round(n))}
/** Left padding for axis labels: the widest label at ~8 px per character (svg text is 10 px), plus the 4 px gap. */
function padFor(labels){var m=0;labels.forEach(function(s){if(String(s).length>m)m=String(s).length});return Math.max(30,m*8+12)}
/** Tooltip icon: the long text lives in data-tip (CSS hover/focus) and aria-label (screen readers). */
function tip(t){return'<span class="tip" tabindex="0" aria-label="'+esc(t)+'" data-tip="'+esc(t)+'">ⓘ</span>'}
function setTip(el,t){el.setAttribute("aria-label",t);el.setAttribute("data-tip",t)}
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
function metricTile(o){
 var sec=o.secondary;
 function col(v,u,sub,cls){return'<div'+(cls?' class="'+cls+'"':"")+'><span class="mt-value">'+(v==null?"–":esc(v))+(v!=null&&u?'<small>'+esc(u)+'</small>':"")+'</span><span class="mt-sub">'+esc(sub||"")+'</span></div>'}
 function fill(v,u,sub,tone){return'<div class="mt-fill"><div class="mt-bar"><i style="width:'+Math.max(0,Math.min(100,v==null?0:v)).toFixed(1)+'%'+(tone?';background:var(--'+esc(tone)+')':'')+'"></i></div><span class="mt-sub">'+esc(u||"")+(sub?" · "+esc(sub):"")+'</span></div>'}
 // the tile's stable id: a slug of its title, so the drag can find and order it (the tile drag keys on data-tid)
 var tid=String(o.title||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"tile";
 return'<div class="mt" data-tid="'+esc(tid)+'" data-tname="'+esc(o.title)+'" data-tval="'+esc((o.value==null?"–":o.value)+(o.value!=null&&o.unit?" "+o.unit:""))+'"><span class="tgrip" data-tgrip tabindex="0" title="move tile" aria-label="move '+esc(o.title)+'" aria-pressed="false" role="button">⠿</span><span class="mt-label">'+(o.icon?'<span class="mt-icon">'+esc(o.icon)+'</span>':"")+esc(o.title)+'</span>'+
  '<div class="mt-values">'+col(o.value,o.unit,o.sub)+(sec?col(sec.value,sec.unit,sec.sub,"mt-sec"):"")+'</div>'+
  (o.extra||"")+(o.fill?fill(o.fill.pct,o.fill.text,o.fill.sub,o.fill.tone):"")+
  '<svg class="mt-spark" viewBox="0 0 ${L.sparkViewMaxPx} ${L.sparkHeightPx}" preserveAspectRatio="none" width="100%" height="${L.sparkHeightPx}">'+metricSpark(o.series||[])+'</svg></div>'
}
/** Baked policy values, declared before the helpers that use them so each extracted function stays self-contained. */
var JOB_TRIES=${n(L.jobMaxTries)},JOB_POLL=${n(L.jobPollMs)},JOB_FIRST=${n(L.jobFirstDelayMs)},SRV_STALE_SEC=${n(L.serverCounterStaleSecs)};
/** Colour thresholds (router.cockpit.layout.thresholds): a hit ratio below HIT_WARN reads amber,
 *  below HIT_BAD red; an error rate at/above ERROR_WARN amber, at/above ERROR_BAD red. */
var HIT_WARN=${n(L.hitWarn)},HIT_BAD=${n(L.hitBad)},ERROR_WARN=${n(L.errorWarn)},ERROR_BAD=${n(L.errorBad)};
/** Colour class of a ratio: red at/above bad, amber at/above warn, else plain. */
function cls(v,warn,bad){return v>=bad?"bad":v>=warn?"warn":""}
/** Colour class of a hit ratio (the rings, the pause table, the sessions table):
 *  red below HIT_BAD, amber below HIT_WARN, else ok. */
function hitCls(r){return r<HIT_BAD?"bad":r<HIT_WARN?"warn":"ok"}
/** Collapsible tiles: every card/panel can fold; the state is saved per tile id and restored on load. */
var COLLAPSE_KEY="pai.cockpit.collapsed";
function collapsedSet(){var s={};try{var r=localStorage.getItem(COLLAPSE_KEY);if(r)JSON.parse(r).forEach(function(k){s[k]=1})}catch(e){}return s}
function saveCollapsed(s){try{var a=[];for(var k in s)if(s[k])a.push(k);localStorage.setItem(COLLAPSE_KEY,JSON.stringify(a))}catch(e){}}
function applyCollapse(){
 var cs=collapsedSet(),cards=document.querySelectorAll("main section.card");
 for(var i=0;i<cards.length;i++)(function(c){
  var h=c.querySelector("h2");if(!h)return;
  if(!c.id)c.id=c.getAttribute("data-section")?"sec-"+c.getAttribute("data-section"):"tile-"+i;
  var b=h.querySelector("button.fold");
  if(!b){b=document.createElement("button");b.type="button";b.className="fold";b.setAttribute("aria-expanded","true");h.insertBefore(b,h.firstChild)}
  var col=!!cs[c.id];
  c.classList.toggle("folded",col);b.setAttribute("aria-expanded",col?"false":"true");
  b.innerHTML='<span class="chev">'+(col?"▸":"▾")+'</span>';
  b.title=col?"expand":"collapse";b.setAttribute("aria-label",(col?"expand ":"collapse ")+h.textContent.trim());
  if(!b.onclick)b.onclick=function(){var s2=collapsedSet();if(s2[c.id])delete s2[c.id];else s2[c.id]=1;saveCollapsed(s2);applyCollapse()};
 })(cards[i]);
}
/** The layout model: rows of section names; a row of n gives each 12/n columns.
 *  The arrangement lives in the browser (localStorage); the default derives from
 *  the page order and the span classes (c8+c4 consecutive = one row, c6+c6 = one
 *  row, c12 = its own row), unless the config's router.cockpit.layout.rows names rows. */
var LKEY="pai.cockpit.layout.v1",TKEY="pai.cockpit.tiles.v1";
var MAXROW=${n(L.maxPerRow)},PRESS_MS=${n(L.touchPressMs)},EDGE_PX=${n(L.edgeScrollPx)},GRIDCOLS=${n(L.gridCols)};
var DEFAULT_ROWS=${JSON.stringify(L.rows)};
function spanOf(c){var m=String(c.className||"").match(/c([0-9]+)/);return m?+m[1]:GRIDCOLS}
/** Consecutive sections share a row while their spans sum to the grid width
 *  (c8+c4, c6+c6), up to MAXROW per row; a c12 is always alone. */
function deriveRows(secs){var rows=[],cur=null;for(var i=0;i<secs.length;i++){var s=spanOf(secs[i]);
 if(cur&&cur.sum+s<=GRIDCOLS&&cur.names.length<MAXROW){cur.names.push(secs[i].getAttribute("data-section"));cur.sum+=s}
 else{if(cur)rows.push(cur.names);cur={names:[secs[i].getAttribute("data-section")],sum:s}}
 if(cur.names.length===MAXROW||cur.sum>=GRIDCOLS){rows.push(cur.names);cur=null}}
 if(cur)rows.push(cur.names);return rows}
/** The default rows of the shipped page, derived once from the static markup
 *  (the section order and the span classes) — no layout literal in code. */
var PAGE_ROWS=(function(){
 var m=document.querySelector("main"),secs=m?m.querySelectorAll("section[data-section]"):[];
 return secs.length?deriveRows(secs):[];
})();
function savedRows(){try{var r=localStorage.getItem(LKEY);if(!r)return null;var a=JSON.parse(r);return Array.isArray(a)?a:null}catch(e){return null}}
function defaultRows(secs){
 if(DEFAULT_ROWS&&DEFAULT_ROWS.length)return DEFAULT_ROWS.map(function(r){return r.slice()});
 // the derivation of the shipped page (the markup the page was built from);
 // a section the page does not carry appends as its own row via cleanRows
 return PAGE_ROWS.length?PAGE_ROWS.map(function(r){return r.slice()}):deriveRows(secs);
}
/** Unknown names dropped, sections missing from the saved layout appended as own rows. */
function cleanRows(rows,secs){
 var names={},seen={},out=[];
 for(var i=0;i<secs.length;i++)names[secs[i].getAttribute("data-section")]=1;
 for(var k=0;k<rows.length;k++){
  var r=[];
  for(var n=0;n<rows[k].length;n++){var name=rows[k][n];if(names[name]&&!seen[name]&&r.length<MAXROW){r.push(name);seen[name]=1}}
  if(r.length)out.push(r);
 }
 // a missing section goes after the row of its default predecessor (the page order), else last
 var def=defaultRows(secs).reduce(function(a,r){return a.concat(r)},[]);
 for(var j=0;j<secs.length;j++){var s=secs[j].getAttribute("data-section");if(seen[s])continue;
  var at=out.length,d=def.indexOf(s);
  for(var p=d-1;p>=0;p--){var hit=-1;for(var q=0;q<out.length;q++)if(out[q].indexOf(def[p])>=0)hit=q;if(hit>=0){at=hit+1;break}}
  out.splice(at,0,[s]);seen[s]=1}
 return out;
}
/** The rows to show: the saved ones (else the default) cleaned against the sections the page
 *  carries; a saved layout that changed by the cleaning (a section added since) is saved again. */
function layoutRows(secs){
 var saved=savedRows(),rows=cleanRows(saved||defaultRows(secs),secs);
 if(saved&&JSON.stringify(rows)!==JSON.stringify(saved))saveRows(rows);
 return rows;
}
function saveRows(rows){try{localStorage.setItem(LKEY,JSON.stringify(rows))}catch(e){}}
/** Run a layout change (a drop, a keyboard move) and leave the page where it was scrolled: moved nodes
 *  must not drag the viewport along, whatever the browser's anchoring does with a detached anchor. */
function keepScroll(fn){
 var x=window.scrollX,y=window.scrollY,r=fn();
 var fix=function(){if(window.scrollY!==y||window.scrollX!==x)window.scrollTo(x,y)};
 fix();window.requestAnimationFrame(fix);
 return r;
}
/** Apply the rows: DOM order = row order, each section spans 12/n columns.
 *  The section elements move, never get rebuilt: folds and listeners survive. */
function applyLayout(rows){
 var main=document.querySelector("main");if(!main)return;
 var byName={},secs=main.querySelectorAll("section[data-section]");
 for(var i=0;i<secs.length;i++)byName[secs[i].getAttribute("data-section")]=secs[i];
 var order=[];
 for(var r=0;r<rows.length;r++){
  var row=rows[r],span=Math.floor(GRIDCOLS/Math.min(row.length,MAXROW));
  for(var k=0;k<row.length;k++){var el=byName[row[k]];if(!el)continue;el.style.gridColumn="span "+span;el.__n=Math.min(row.length,MAXROW);order.push(el)}
 }
 for(var j=0;j<order.length;j++)main.appendChild(order[j]);
 stackRows();
}
/** Row stacking: a row of n sections stacks (full width) only when the main width / n
 *  is under MINSEC — an 822 px window keeps a row of 2 side by side (411 each) and stacks
 *  a row of 3 (274 each). Driven by the live main width (ResizeObserver), not a media query. */
var MINSEC=${n(L.minSectionPx)};
function stackRows(){
 var main=document.querySelector("main");if(!main)return;
 var w=main.clientWidth||window.innerWidth||0;
 var secs=main.querySelectorAll("section[data-section]");
 for(var i=0;i<secs.length;i++){
  var n=secs[i].__n||1;
  secs[i].classList.toggle("stacked",w/n<MINSEC);
 }
}
function moveSec(name,rows,target,mode){
 var ri=-1,si=-1,t=-1,kk=-1;
 for(var r=0;r<rows.length;r++){var k=rows[r].indexOf(name);if(k>=0){ri=r;si=k}var j=rows[r].indexOf(target);if(j>=0){t=r;kk=j}}
 if(ri<0||t<0)return rows;
 var out=rows.map(function(x){return x.slice()});
 // beside: a full row refuses the drop, nothing moves
 if((mode==="left"||mode==="right")&&t!==ri&&out[t].length>=MAXROW)return rows;
 out[ri].splice(si,1);
 kk=out[t].indexOf(target);
 if(mode==="above")out.splice(t,0,[name]);
 else if(mode==="below")out.splice(t+1,0,[name]);
 else out[t].splice(mode==="left"?kk:kk+1,0,name);
 for(var q=out.length-1;q>=0;q--)if(!out[q].length)out.splice(q,1);
 return out;
}
/** Tile order inside a container (model cards in .rt-grid, metric tiles in .rt-tiles):
 *  saved per container key (section name + card id); applied after every rebuild. */
function tileOrder(){try{var r=localStorage.getItem(TKEY);if(!r)return {};var o=JSON.parse(r);return o&&typeof o==="object"?o:{}}catch(e){return{}}}
function saveTileOrder(o){try{localStorage.setItem(TKEY,JSON.stringify(o))}catch(e){}}
/** The tile ids of a container, in order: its own tiles, then the minimized chips row after it. */
function tids(cont){
 var ids=[],k,c=cont.children;
 for(k=0;k<c.length;k++)if(c[k].parentNode===cont&&c[k].getAttribute("data-tid"))ids.push(c[k].getAttribute("data-tid"));
 if(cont.__chips)for(k=0;k<cont.__chips.children.length;k++)ids.push(cont.__chips.children[k].getAttribute("data-tid"));
 return ids;
}
function tkeyOf(cont){return cont.__tkey||cont.getAttribute("data-tkey")}
/** Order and minimized state of one tile container, from the saved state (key = the container's tkey; the
 *  minimized ids live under tkey+"#min"). Run after every rebuild: tiles the saved state does not know go
 *  last in DOM order, ids that no longer exist drop out of it, minimized tiles become chips in a row after
 *  the container, and every tile carries its minimize button. */
function applyTileOrder(el){
 var key=tkeyOf(el),st=tileOrder(),ord=st[key]||[],mins=(el.getAttribute&&el.getAttribute("data-tnomin"))?[]:(st[key+"#min"]||[]);
 var kids=el.children,all=[],byId={},keep=[],i,k;
 // live children only: a tile moved here earlier still sits in a stale container's children array
 for(i=0;i<kids.length;i++){if(kids[i].parentNode!==el)continue;var id=kids[i].getAttribute("data-tid");if(!id){keep.push(kids[i]);continue}byId[id]=kids[i]}
 if(el.__chips)for(i=0;i<el.__chips.children.length;i++){var cc=el.__chips.children[i];byId[cc.getAttribute("data-tid")]=cc}
 var known=0;
 for(k=0;k<ord.length;k++)if(byId[ord[k]]){all.push(byId[ord[k]]);known++}
 var seen={};ord.forEach(function(x){seen[x]=1});
 for(var id2 in byId)if(!seen[id2])all.push(byId[id2]);
 // a state naming ids the container no longer has is pruned, but never from an empty container (not rendered yet)
 if(all.length){
  var po=ord.filter(function(x){return byId[x]}),pm=mins.filter(function(x){return byId[x]});
  if(po.length!==ord.length||pm.length!==mins.length){var o2=tileOrder();if(po.length)o2[key]=po;else delete o2[key];if(pm.length)o2[key+"#min"]=pm;else delete o2[key+"#min"];saveTileOrder(o2)}
  ord=po;mins=pm;
 }
 var open=[],chips=[];
 all.forEach(function(t){(mins.indexOf(t.getAttribute("data-tid"))>=0?chips:open).push(t)});
 open.forEach(function(t){el.appendChild(t)});
 keep.forEach(function(t){el.appendChild(t)});
 if(chips.length){
  if(!el.__chips||el.__chips.parentNode!==el.parentNode){el.__chips=document.createElement("div");el.__chips.className="tchips";el.parentNode.insertBefore(el.__chips,el.nextSibling)}
  chips.forEach(function(t){el.__chips.appendChild(t)});
 }else if(el.__chips){el.__chips.parentNode&&el.__chips.parentNode.removeChild(el.__chips);el.__chips=null}
 all.forEach(function(t){
  var tid=t.getAttribute("data-tid"),min=mins.indexOf(tid)>=0,nm=t.getAttribute("data-tname")||tid;
  t.classList.toggle("tmin",min);
  var b=t.__tmb;
  t.__tcont=el;wireSpan(t,nm);
  if((el.getAttribute&&el.getAttribute("data-tnomin"))){return}
  if(!b){
   b=t.__tmb=document.createElement("button");b.type="button";b.className="tctl";
   b.onclick=function(){
    var s2=tileOrder(),c2=t.__tcont,kk=tkeyOf(c2)+"#min",m2=(s2[kk]||[]).slice(),ix=m2.indexOf(t.getAttribute("data-tid"));
    if(ix>=0)m2.splice(ix,1);else m2.push(t.getAttribute("data-tid"));
    if(m2.length)s2[kk]=m2;else delete s2[kk];
    saveTileOrder(s2);applyTileOrder(c2);if(b.focus)b.focus({preventScroll:true});
   };
   t.appendChild(b);
  }
  t.__tcont=el;
  b.setAttribute("aria-pressed",min?"true":"false");
  b.setAttribute("aria-label",(min?"restore ":"minimize ")+nm);b.title=min?"restore":"minimize";
  b.textContent=min?"+":"–";
 });
 applySpans(el,open);
 el.__html=""; // the html no longer matches the source string: a later identical poll must re-apply
}
/** Tile widths in a 12-column grid: 12 full, 6 half, 4 third, 3 quarter. Saved beside the order under
 *  tkey+"#w" ({tid:span}). A container with no saved span keeps its own auto layout untouched; one with
 *  any gets the 12-column grid, and its other tiles keep the width they had (measured, snapped). */
var SPANS=[12,6,4,3],SPAN_MARK={12:"1",6:"\u00bd",4:"\u2153",3:"\u00bc"};
function snapSpan(w,full){
 if(!(full>0)||!(w>0))return 12;
 var r=w/full*12,best=12;
 SPANS.forEach(function(c){if(Math.abs(c-r)<Math.abs(best-r))best=c});
 return best;
}
function applySpans(el,open){
 var key=tkeyOf(el),sp=tileOrder()[key+"#w"]||{},any=false,i;
 for(i=0;i<open.length;i++)if(sp[open[i].getAttribute("data-tid")])any=true;
 if(!any){el.classList.toggle("tspan",false);for(i=0;i<open.length;i++){if(open[i].style&&open[i].style.removeProperty)open[i].style.removeProperty("--sp");open[i].__sp=0;if(open[i].__twd)open[i].__twd.textContent="\u2194"}return}
 // measure the auto layout before the 12-column grid replaces it
 el.classList.toggle("tspan",false);
 var full=el.offsetWidth||0;
 for(i=0;i<open.length;i++){var t=open[i];t.__dsp=snapSpan(t.offsetWidth||0,full)}
 el.classList.toggle("tspan",true);
 for(i=0;i<open.length;i++){
  var t2=open[i],v=sp[t2.getAttribute("data-tid")]||t2.__dsp||12;
  t2.__sp=v;
  if(t2.style&&t2.style.setProperty)t2.style.setProperty("--sp",String(v));
  if(t2.__twd)t2.__twd.textContent=SPAN_MARK[v]||"\u2194";
 }
}
/** The width control on a tile: a click cycles full, half, third, quarter and saves it. */
function wireSpan(t,nm){
 var b=t.__twd;
 if(!b){
  b=t.__twd=document.createElement("button");b.type="button";b.className="twd";
  b.onclick=function(){
   var c=t.__tcont,s=tileOrder(),k=tkeyOf(c)+"#w",m=Object.assign({},s[k]||{}),id=t.getAttribute("data-tid");
   var cur=m[id]||(t.__sp?t.__dsp:snapSpan(t.offsetWidth||0,c.offsetWidth||0))||12,nx=SPANS[(SPANS.indexOf(cur)+1)%SPANS.length];
   m[id]=nx;s[k]=m;saveTileOrder(s);applyTileOrder(c);
   if(t.__twd&&t.__twd.focus)t.__twd.focus({preventScroll:true});
  };
  t.appendChild(b);
 }
 b.setAttribute("aria-label","width of "+nm);b.title="width: click to cycle full, half, third, quarter";
 if(!b.textContent)b.textContent="\u2194";
}
/** Tile ids, chip name and chip value as attributes, and the move grip: the markup every orderable tile carries. */
function tileAttrs(id,name,val){return' data-tid="'+esc(id)+'" data-tname="'+esc(name)+'" data-tval="'+esc(val)+'"'}
function tileGrip(name){return'<span class="tgrip" data-tgrip tabindex="0" title="move tile" aria-label="move '+esc(name)+'" aria-pressed="false" role="button">⠿</span>'}
/** Re-apply the saved order and minimized state to every tile container under root (run after each setHtml of a tile section). */
function orderTiles(root){
 var tgs=root.querySelectorAll?root.querySelectorAll("[data-tkey]"):[];
 for(var ti=0;ti<tgs.length;ti++){tgs[ti].__tkey=tgs[ti].getAttribute("data-tkey");applyTileOrder(tgs[ti])}
 tileGrips();
}
var ARROWS={ArrowLeft:-1,ArrowUp:-1,ArrowRight:1,ArrowDown:1};
/** Keyboard grab: Enter/Space on a grip toggles it; while grabbed the arrow keys move the item (Alt+arrow works without). */
function grabToggle(g,on){
 if(on===undefined)on=!g.__grab;
 g.__grab=!!on;g.classList.toggle("grab",!!on);g.setAttribute("aria-pressed",on?"true":"false");
}
/** Move a tile one place in its container's saved order and re-apply it at once. */
function moveTileBy(tile,delta){
 var cont=tile.parentNode,ord=tids(cont),id=tile.getAttribute("data-tid"),p=ord.indexOf(id),np=p+delta;
 if(p<0||np<0||np>=ord.length)return false;
 ord.splice(p,1);ord.splice(np,0,id);
 // __tkey is set by orderTiles; fall back to the container's own data-tkey
 var o=tileOrder();o[tkeyOf(cont)]=ord;saveTileOrder(o);keepScroll(function(){applyTileOrder(cont)});
 return true;
}
function tileGrips(){
 var gs=document.querySelectorAll("[data-tgrip]");
 for(var i=0;i<gs.length;i++)(function(g){
  if(g.__wired)return;g.__wired=1;
  // a grip whose tile carries no data-tid cannot be ordered: the drag would find no tile and do nothing
  var ok=function(){return g.parentNode.getAttribute("data-tid")&&!g.parentNode.classList.contains("tmin")};
  g.addEventListener("pointerdown",function(e){if(ok())sDrag(e,g,"tile")});
  g.addEventListener("keydown",function(e){
   if(!ok())return;
   if(e.key==="Enter"||e.key===" "){e.preventDefault();grabToggle(g);return}
   if(e.key==="Escape"&&g.__grab){grabToggle(g,false);return}
   var dl=ARROWS[e.key];
   if(!dl||(!e.altKey&&!g.__grab))return;
   e.preventDefault();
   // re-attaching the focused node blurs it: that must not end the grab
   g.__moving=1;
   if(moveTileBy(g.closest("[data-tid]"),dl)&&g.focus)g.focus({preventScroll:true});
   g.__moving=0;
  });
  g.addEventListener("blur",function(){if(!g.__moving)grabToggle(g,false)});
 })(gs[i]);
}
/** Drag, one mechanism for section grips and tile grips (pointer events: mouse at once, touch after a long press).
 *  The listeners live on the window and the drag holds ids, never nodes: a poll re-render replaces the tile
 *  nodes (the grip included) while the pointer is down, and a listener on the grip would be gone with it. */
var drag=null,ind=null,DROP_PAD=40,BAR=4;
function showBar(b,bad){
 if(!ind){ind=document.createElement("div");ind.className="dropind";document.body.appendChild(ind)}
 ind.style.left=b.x+"px";ind.style.top=b.y+"px";ind.style.width=b.w+"px";ind.style.height=b.h+"px";
 ind.dataset.mode=b.mode;ind.classList.toggle("bad",!!bad);
}
function hideInd(){if(ind){ind.remove();ind=null}}
function edgeScroll(y){
 var d=document.documentElement,vp=d.clientHeight;
 if(y<EDGE_PX)window.scrollBy(0,-8);else if(y>vp-EDGE_PX)window.scrollBy(0,8);
}
function sDrag(e,g,kind){
 if(e.button||drag)return;
 drag={kind:kind,moved:false,timer:null,drop:null,mark:null};
 if(kind==="section"){var sec=g.closest("section");drag.sec=sec;drag.name=sec.getAttribute("data-section")}
 else{var tl=g.closest("[data-tid]");drag.tid=tl.getAttribute("data-tid");drag.key=tkeyOf(tl.parentNode)}
 window.addEventListener("pointermove",mDrag);
 window.addEventListener("pointerup",uDrag);
 window.addEventListener("pointercancel",aDrag);
 window.addEventListener("keydown",kDrag);
 window.addEventListener("blur",aDrag);
 if(e.pointerType==="touch")drag.timer=setTimeout(function(){drag.timer=null;drag.armed=true},PRESS_MS);
 else drag.armed=true;
 e.preventDefault();
}
/** The dragged tile and its container, found again by key and id in the live page. */
function liveTile(d){
 var cs=document.querySelectorAll("[data-tkey]");
 for(var i=0;i<cs.length;i++){
  if(tkeyOf(cs[i])!==d.key)continue;
  var ch=cs[i].children;
  for(var k=0;k<ch.length;k++)if(ch[k].parentNode===cs[i]&&ch[k].getAttribute("data-tid")===d.tid)return{cont:cs[i],tile:ch[k]};
 }
 return null;
}
/** The point's squared distance to a rect (0 inside it). */
function rectDist(r,x,y){var dx=Math.max(r.left-x,0,x-(r.left+r.width)),dy=Math.max(r.top-y,0,y-(r.top+r.height));return dx*dx+dy*dy}
/** The gap a tile drop would go to: the open tile nearest the pointer (reading order breaks ties), before or
 *  after it by which half of it the pointer is in — along x when the tile shares its row with another, else y.
 *  Null outside the container (plus DROP_PAD) and when there is no other tile. */
function tileDrop(d,x,y){
 var lt=liveTile(d);if(!lt)return null;
 var cr=lt.cont.getBoundingClientRect();
 if(x<cr.left-DROP_PAD||x>cr.left+cr.width+DROP_PAD||y<cr.top-DROP_PAD||y>cr.top+cr.height+DROP_PAD)return null;
 var vis=[],ch=lt.cont.children,i;
 for(i=0;i<ch.length;i++)if(ch[i].parentNode===lt.cont&&ch[i].getAttribute("data-tid")&&!ch[i].classList.contains("tmin"))vis.push(ch[i]);
 var best=null,bd=0,br=null;
 for(i=0;i<vis.length;i++){
  if(vis[i]===lt.tile)continue;
  var r=vis[i].getBoundingClientRect(),dd=rectDist(r,x,y);
  if(!best||dd<bd){best=vis[i];bd=dd;br=r}
 }
 if(!best)return null;
 var horiz=false;
 for(i=0;i<vis.length;i++)if(vis[i]!==best&&Math.abs(vis[i].getBoundingClientRect().top-br.top)<br.height/2)horiz=true;
 var before=horiz?x<br.left+br.width/2:y<br.top+br.height/2,bar;
 if(horiz)bar={x:before?br.left-BAR-1:br.left+br.width+1,y:br.top,w:BAR,h:br.height,mode:before?"left":"right"};
 else bar={x:br.left,y:before?br.top-BAR-1:br.top+br.height+1,w:br.width,h:BAR,mode:before?"above":"below"};
 return{ref:best.getAttribute("data-tid"),before:before,bar:bar,bad:false};
}
/** The section gap under the pointer: the section nearest it; its outer quarters (top, bottom) give a new row
 *  above/below, else the left/right half puts the dragged one into the same row beside it. */
function secDrop(d,x,y){
 var secs=document.querySelectorAll("main section.card"),best=null,bd=0,br=null,i;
 for(i=0;i<secs.length;i++){
  if(secs[i].getAttribute("data-section")===d.name)continue;
  var r=secs[i].getBoundingClientRect(),dd=rectDist(r,x,y);
  if(!best||dd<bd){best=secs[i];bd=dd;br=r}
 }
 if(!best||bd>DROP_PAD*DROP_PAD)return null;
 var name=best.getAttribute("data-section"),mode,bar;
 if(y<br.top+br.height/4)mode="above";else if(y>br.top+br.height*3/4)mode="below";else mode=x<br.left+br.width/2?"left":"right";
 if(mode==="above")bar={x:br.left,y:br.top-BAR-1,w:br.width,h:BAR};
 else if(mode==="below")bar={x:br.left,y:br.top+br.height+1,w:br.width,h:BAR};
 else bar={x:mode==="left"?br.left-BAR-1:br.left+br.width+1,y:br.top,w:BAR,h:br.height};
 bar.mode=mode;
 var rows=curRows(),ri=-1,ti=-1;
 for(i=0;i<rows.length;i++){if(rows[i].indexOf(d.name)>=0)ri=i;if(rows[i].indexOf(name)>=0)ti=i}
 return{ref:name,mode:mode,bar:bar,bad:(mode==="left"||mode==="right")&&ri!==ti&&ti>=0&&rows[ti].length>=MAXROW};
}
function dropAt(d,x,y){return d.kind==="tile"?tileDrop(d,x,y):secDrop(d,x,y)}
/** The dragged item shown dimmed in place; re-marked each move because a re-render replaces the node. */
function markDragged(d){
 var el=d.kind==="tile"?(liveTile(d)||{}).tile:d.sec;
 if(d.mark&&d.mark!==el)d.mark.classList.toggle("dragging",false);
 if(el){el.classList.toggle("dragging",true);d.mark=el}
}
function mDrag(e){
 if(!drag)return;
 drag.moved=true;
 if(!drag.armed)return;
 edgeScroll(e.clientY);
 markDragged(drag);
 drag.drop=dropAt(drag,e.clientX,e.clientY);
 if(drag.drop)showBar(drag.drop.bar,drag.drop.bad);else hideInd();
}
function uDrag(e){
 if(!drag)return;
 var d=drag,drop=null;
 if(d.armed&&d.moved)drop=dropAt(d,e.clientX,e.clientY);
 endDrag();
 if(!drop||drop.bad)return;
 if(d.kind==="tile"){
  var lt=liveTile(d);if(!lt)return;
  var ord=tids(lt.cont),was=ord.join("\n"),p=ord.indexOf(d.tid);
  if(p<0)return;
  ord.splice(p,1);
  var ti=ord.indexOf(drop.ref);
  if(ti<0)return;
  ord.splice(drop.before?ti:ti+1,0,d.tid);
  if(ord.join("\n")===was)return; // dropped where it already was: nothing to save
  var o=tileOrder();o[tkeyOf(lt.cont)]=ord;saveTileOrder(o);keepScroll(function(){applyTileOrder(lt.cont)});
  return;
 }
 var rows=curRows(),rows2=moveSec(d.name,rows,drop.ref,drop.mode);
 if(rows2===rows)return; // refused (a 4th beside)
 saveRows(rows2);keepScroll(function(){applyLayout(rows2)});
}
/** Every drag trace gone: listeners, press timer, dimmed item, indicator. */
function endDrag(){
 var d=drag;drag=null;
 window.removeEventListener("pointermove",mDrag);
 window.removeEventListener("pointerup",uDrag);
 window.removeEventListener("pointercancel",aDrag);
 window.removeEventListener("keydown",kDrag);
 window.removeEventListener("blur",aDrag);
 if(d){if(d.timer){clearTimeout(d.timer);d.timer=null}if(d.mark)d.mark.classList.toggle("dragging",false)}
 hideInd();
}
function aDrag(){if(drag)endDrag()}
function kDrag(e){if(e.key==="Escape")aDrag()}
function curRows(){
 var main=document.querySelector("main");
 return cleanRows(savedRows()||defaultRows(main.querySelectorAll("section[data-section]")),main.querySelectorAll("section[data-section]"));
}
/** Grip before the fold chevron in every section h2; keyboard: Alt+Arrow moves. */
function secGrips(){
 var secs=document.querySelectorAll("main section.card");
 for(var i=0;i<secs.length;i++)(function(sec){
  var h=sec.querySelector("h2");if(!h)return;
  var g=h.querySelector("button.sgrip");
  if(!g){
   g=document.createElement("button");g.type="button";g.className="sgrip";g.textContent="⠿";
   g.title="move section";g.setAttribute("aria-label","move "+(h.textContent||"").trim());
   h.insertBefore(g,h.firstChild);
   g.addEventListener("pointerdown",function(e){sDrag(e,g,"section")});
   g.addEventListener("blur",function(){if(!g.__moving)grabToggle(g,false)});
   g.addEventListener("keydown",function(e){
    if(e.key==="Enter"||e.key===" "){e.preventDefault();grabToggle(g);return}
    if(e.key==="Escape"&&g.__grab){grabToggle(g,false);return}
    if(!e.altKey&&!g.__grab)return;
    var name=sec.getAttribute("data-section"),rows=curRows(),ri=-1,si=-1;
    for(var r=0;r<rows.length;r++){var k=rows[r].indexOf(name);if(k>=0){ri=r;si=k;break}}
    if(ri<0)return;
    if(e.key==="ArrowUp"||e.key==="ArrowDown"){
     e.preventDefault();
     var t=ri+(e.key==="ArrowDown"?1:-1);
     if(t<0||t>=rows.length)return;
     rows[ri].splice(si,1);
     if(rows[ri].length===0)rows.splice(ri,1);
     rows.splice(t,0,[name]);
    }else if(e.key==="ArrowLeft"||e.key==="ArrowRight"){
     e.preventDefault();
     var row=rows[ri];
     if(e.key==="ArrowRight"){
      if(row.length>=MAXROW){rows[ri].splice(si,1);if(rows[ri].length===0)rows.splice(ri,1);rows.splice(ri+1,0,[name])}
      else if(si<row.length-1)row.splice(si,1),row.splice(si+1,0,name);
     }else if(si>0)row.splice(si,1),row.splice(si-1,0,name);
     else{rows[ri].splice(si,1);if(rows[ri].length===0)rows.splice(ri,1);rows.splice(ri-1<0?0:ri-1,0,[name])}
    }else return;
    g.__moving=1;
    saveRows(rows);applyLayout(rows);
    if(g.focus)g.focus({preventScroll:true});
    g.__moving=0;
   });
  }
  var b=h.querySelector("button.fold");
  if(b)h.insertBefore(g,b); // the grip sits left of the fold chevron
 })(secs[i]);
}
function resetLayout(){try{localStorage.removeItem(LKEY)}catch(e){}applyLayout(layoutRows(document.querySelectorAll("section[data-section]")));stackRows()}
`;
