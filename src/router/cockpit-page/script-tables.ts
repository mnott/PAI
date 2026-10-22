/** cockpit-page — script: donuts, provider tiles, tables, render and load. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** donut through loadSystem. */
export const scriptTables = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`function donut(ratio,sz,tone){
 var r=${n(L.donutRadiusPx)},c=2*Math.PI*r,d=c*ratio;sz=sz||${n(L.donutSizePx)};
 var cx=${n(L.donutViewBoxPx)}/2;
 var lab=pct(ratio),fs=sz>120?28:22,inner=2*r-${n(L.donutStrokePx)};fs=Math.min(fs,inner/(lab.length*0.62));
 return'<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 '+${n(L.donutViewBoxPx)}+' '+${n(L.donutViewBoxPx)}+'"><circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="var(--line)" stroke-width="${n(L.donutStrokePx)}"/><circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="'+(tone?"var(--"+tone+")":hitCls(ratio)==="bad"?"var(--bad)":hitCls(ratio)==="warn"?"var(--warn)":"var(--ok)")+'" stroke-width="${n(L.donutStrokePx)}" stroke-dasharray="'+d.toFixed(1)+' '+c.toFixed(1)+'" transform="rotate(-90 '+cx+' '+cx+')"/><text x="'+cx+'" y="'+(sz>120?79:76)+'" text-anchor="middle" style="font-size:'+fs+'px;font-weight:600;fill:var(--fg)">'+lab+'</text></svg>';
}
function emptyRing(sz){
 sz=sz||${n(L.donutSizePx)};
 var cx=${n(L.donutViewBoxPx)}/2;
 return'<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 '+${n(L.donutViewBoxPx)}+' '+${n(L.donutViewBoxPx)}+'"><circle cx="'+cx+'" cy="'+cx+'" r="${n(L.donutRadiusPx)}" fill="none" stroke="var(--line)" stroke-width="${n(L.donutStrokePx)}"/></svg>';
}
/** Models under LOW_REQ requests: one chip line under the grid, details on hover. */
function lowChips(ms){
 var low=Object.keys(ms).map(function(k){return ms[k]}).filter(function(m){return m.requests<LOW_REQ});
 if(!low.length)return"";
 var tt=low.map(function(m){var dn=m.cacheRead+m.cacheWrite+m.input;return m.provider+" · "+m.model+": "+m.requests+" req"+(dn&&m.cacheRead+m.cacheWrite>0?", hit "+pct(m.cacheRead/dn):"")}).join("\n");
 return'<span class="chip dim" title="'+esc(tt)+'">+'+low.length+' model'+(low.length===1?'':'s')+' with &lt;'+LOW_REQ+' requests</span>';
}
/** hit% cell of the providers table: loopback providers report no cache fields, so show the server counter, marked. */
/** " (Ns old)" when the server counter is a kept reading older than one poll interval (60 s). */
function ageMark(s){
 return s&&s.prefixCacheAgeSec>SRV_STALE_SEC?' <span class="dim">('+(s.prefixCacheAgeSec>=2*SRV_STALE_SEC?Math.round(s.prefixCacheAgeSec/60)+' min':s.prefixCacheAgeSec+'s')+' old)</span>':''
}
function provHit(p,servers){
 var srv=(servers||[]).filter(function(s){return s.provider===p.provider})[0];
 if(p.cacheRead+p.cacheWrite>0||!srv)return pct(p.hitRatio);
 return srv.prefixCache?'<span title="server prefix-cache counter since server start">'+pct(srv.prefixCache.hitRate)+'*</span>'+ageMark(srv):'<span class="dim">n/a</span>';
}
/** One compact line per loopback provider (no ring: the providers grid tile already shows the hit rate). */
function localDetail(prov,pc,tot,age){
 var mem=(pc.entries!=null?pc.entries+" entries":"")+(pc.entries!=null&&pc.memoryMb!=null?" / ":"")+(pc.memoryMb!=null?Math.round(pc.memoryMb)+" MB":"");
 return'<div class="s"><b>'+esc(prov)+'</b> · '+pc.hits+' hit / '+pc.misses+' miss · '+fmt(pc.tokensSaved)+' tokens saved (server, since start)'+(mem?' · '+mem:'')+(tot?' · router log: '+fmt(tot)+' prompt tokens (since restart)':'')+(age||'')+'</div>';
}
/** One box for every table: fixed layout, so the table never scrolls sideways — headers and
 *  numbers sit on one line (nowrap) and the text columns wrap or ellipsise, the full text in
 *  the cell's title. When the table does not fit its box (fitTables) CSS turns each row into a stacked card — the
 *  column label rides on each cell as data-l.
 *  A column empty in every row is not rendered at all (header, cells, stacked label):
 *  it only wastes width, and only when rows exist to judge by. A cell is empty when
 *  its TEXT is: tags stripped, &nbsp; a space, trimmed — "" or a placeholder the
 *  renderers emit for "no value" ("-", "…", "n/a"). Markup with no text at all
 *  (<span class="dim"></span>) counts as empty too.
 *  head entries may carry a class after a space ("label .txt"): the class rides on the
 *  header and every cell of the column (data-l keeps the bare label). A column with no
 *  class is numeric: nowrap, ellipsis only. */
function table(head,rows,tips,tdStyle){
 var EMPTY_TEXT=["","-","…","n/a"];
 var cellText=function(c){return String(c==null?"":c).replace(/<[^>]*>/g,"").replace(/&nbsp;/gi," ").trim()};
 var clsOf=function(h){var m=String(h).match(/^(.*?)\s+(\.[^\s]+)$/);return m?m[2].slice(1):""};
 var labOf=function(h){return String(h).replace(/\s+\.[^\s]+$/,"")};
 var keep=rows.length?head.map(function(h,i){return !rows.every(function(r){return EMPTY_TEXT.indexOf(cellText(r[i]))>=0})}):head.map(function(){return true});
 var head2=head.filter(function(h,i){return keep[i]});
 var row2=rows.map(function(r){var out=[];head.forEach(function(h,i){if(keep[i])out.push(r[i])});return out});
 return'<div class="tw"><table><thead><tr>'+head2.map(function(h){var c=clsOf(h);return'<th'+(c?' class="'+c+'"':'')+(tips&&tips[labOf(h)]?' title="'+esc(tips[labOf(h)])+'"':'')+'>'+labOf(h)+'</th>'}).join("")+'</tr></thead><tbody>'+row2.map(function(r){return'<tr>'+r.map(function(c,i){var k=clsOf(head2[i]);return'<td'+(k?' class="'+k+'"':'')+' data-l="'+esc(labOf(head2[i])||"")+'"'+(tdStyle&&tdStyle[labOf(head2[i])]?' style="'+tdStyle[labOf(head2[i])]+'"':'')+'>'+c+'</td>'}).join("")+'</tr>'}).join("")+'</tbody></table></div>'
}
/** Verdict colour by prefix: ok* green, failed red, "report flagged" and an escalated hand-off amber, the rest dim.
 *  A missing verdict is dim, never a crash. One helper for both verdict tables. */
function vcls(v){return v==null?"dim":String(v).indexOf("ok")===0?"ok":String(v).indexOf("failed")===0?"bad":String(v).indexOf("report flagged")>=0||String(v).indexOf("escalated")===0||String(v).indexOf("handed to session")===0?"warn":"dim"}
/** Speed per model as bars. One row per model, three columns (TTFT p50 with a whisker to p90, output tok/s, prompt read tok/s), each on ONE scale shared by all rows.
 *  Window: "1h" reads h1, every other selector value reads h24 (the server keeps only those two). A missing value is an empty bar and "–", never 0.
 *  localSet: provider names served by a local server. Pure (no DOM) so the tests can run it. */
function speedBars(sp,w,localSet){
 var k=w==="1h"?"h1":"h24",span=w==="1h"?"last hour":"last 24 h",num=function(v){return v!=null&&isFinite(v)};
 var rows=sp.map(function(r){return{r:r,s:r[k]||{}}}).sort(function(a,b){return(b.s.requests||0)-(a.s.requests||0)});
 function mx(f){var m=0;rows.forEach(function(x){var v=f(x.s);if(num(v)&&v>m)m=v});return m}
 var mT=mx(function(s){return num(s.ttftP90)?s.ttftP90:s.ttftP50}),mW=mx(function(s){return s.writeTps}),mR=mx(function(s){return s.readTps});
 function sec(ms){return(ms/1000).toFixed(1)+" s"}
 function tps(v){return(v<10?v.toFixed(1):String(Math.round(v)))+" tok/s"}
 function pc(v,m){return m>0?Math.max(1,Math.min(100,v/m*100)).toFixed(1):"0"}
 function track(inner,label,col){return'<div class="sp-c"><div class="sp-t">'+inner+'</div><div class="sp-l'+(col?'':' dim')+'">'+label+'</div></div>'}
 function bar(v,m,col){return num(v)?track('<i style="width:'+pc(v,m)+'%;background:'+col+'"></i>',tps(v),1):track('',"–",0)}
 var h='<div class="sp"><style>.sp{display:grid;gap:6px 10px;grid-template-columns:repeat(3,minmax(120px,1fr));align-items:center;font-size:12px}.sp>div{min-width:0}.sp-h{color:var(--dim);font-size:11px;line-height:13px;max-height:26px;overflow:hidden}.sp-n{grid-column:1/-1;margin-top:4px}.sp-n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sp-t{position:relative;height:8px;border-radius:4px;background:var(--line);overflow:hidden}.sp-t i{position:absolute;left:0;top:0;bottom:0;border-radius:4px}.sp-t b{position:absolute;top:3px;height:2px;background:var(--fg);opacity:.55}.sp-l{margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sp-tag{font-size:10px;padding:0 4px;border:1px solid var(--line);border-radius:3px;color:var(--dim);margin-left:4px}</style>'
  +'<div class="sp-h" title="Median time from request sent to first content token; the thin line reaches to p90. '+span+'.">Time to first token · '+span+'</div><div class="sp-h" title="Local: output tokens / decode time. Cloud: output tokens / whole reply time (the stream is buffered, so a decode window would overstate it). Replies of 16+ tokens only. '+span+'.">Output speed · '+span+'</div><div class="sp-h" title="Prompt tokens (input + cache read + cache creation) / time to first token. '+span+'.">Prompt processed / TTFT · '+span+'</div>';
 rows.forEach(function(x){
  var r=x.r,s=x.s,loc=r.local!==undefined?r.local:localSet&&localSet[r.provider],t=s.ttftP50,t9=s.ttftP90,tt;
  if(num(t)){tt=track('<i style="width:'+pc(t,mT)+'%;background:#3b6fe0"></i>'+(num(t9)&&t9>t?'<b style="left:'+pc(t,mT)+'%;width:'+(pc(t9,mT)-pc(t,mT)).toFixed(1)+'%"></b>':''),sec(t)+(num(t9)?' (p90 '+sec(t9)+')':''),1)}else tt=track('',"–",0);
  h+='<div class="sp-n'+(s.requests?'':' dim')+'" title="'+esc(r.provider+" / "+r.model+" · "+(s.requests||0)+" requests, "+span)+'">'+esc(r.model)+' <span class="dim">'+(s.requests||0)+'</span><span class="sp-tag">'+(loc?"LOCAL":"CLOUD")+'</span></div>'+tt+bar(s.writeTps,mW,"#3bb36f")+bar(s.readTps,mR,"#e0703b");
 });
 return h+'</div>';
}
function speedHtml(){
 var sp=(data&&data.speed)||[],ls={};
 ((sys&&sys.servers)||[]).forEach(function(s){ls[s.provider]=1});((lim&&lim.limits)||[]).forEach(function(l){if(l.kind==="local")ls[l.provider]=1});
 return sp.length?speedBars(sp,win,ls):'<span class="dim" title="Timing is recorded for streamed replies since the router restart.">no timed requests yet</span>';
}
/** One row for both Worker runs and Sessions by tokens (one owner): status dot, label, model chip, token bar relative to o.max, number, right-hand cell (duration or age), hit%, optional extra markup; full detail in the row's title.
 *  o: {st dot state, lab, full tooltip, dot title, model, models, w tokens, max, du, hit ratio|null, extra markup}. */
function runRow(o){
 var pc=o.w>0?Math.max(2,Math.round(o.w/o.max*100)):0;
 return'<div class="wr-row" title="'+esc(o.full)+'"><i class="wr-dot wr-'+o.st+'" title="'+esc(o.dotTitle)+'"></i><span class="wr-lab">'+esc(o.lab)+'</span><span class="badge" title="'+esc((o.models||[]).join(", ")||"no model")+'">'+esc(o.model)+'</span><span class="wr-bar" title="tokens: '+fmt(o.w)+'"><i style="width:'+pc+'%"></i></span><span class="wr-n">'+(o.w?fmt(o.w):"–")+'</span><span class="wr-du">'+o.du+'</span><span class="'+hitCls(o.hit)+'" title="cache hit">'+(o.hit==null?"–":pct(o.hit))+'</span>'+(o.extra||"")+'</div>'
}
/** Sessions by tokens: one runRow per session (dot: error red, worker verdict colour, active in the last 5 min blue, else dim), rows past the top N folded into one expandable row (state in localStorage like folds). */
var SESS_MORE_KEY="pai.cockpit.sessmore";
function sessMore(){try{return localStorage.getItem(SESS_MORE_KEY)==="1"}catch(e){return false}}
function sessionsHtml(d){
 var all=d.bySession.slice(0,SESSION_ROWS).slice().sort(function(a,b){return tot(b)-tot(a)}),top=${n(L.sessionsTopRows)},open=sessMore(),max=all.length?tot(all[0]):0;
 function row(s){
  var ms=s.models||[],t=tot(s),recent=s.lastTs&&Date.now()-new Date(s.lastTs).getTime()<300000;
  var st=s.errors?"bad":s.worker?vcls(s.verdict):recent?"run":"dim";
  var lab=s.name||s.session.slice(0,8);
  var full=lab+" · "+s.session+(s.worker?" · worker "+s.worker+" · "+(s.verdict||"worker"):"")+"\n"+s.requests+" req · fresh in "+fmt(s.input+s.cacheWrite)+" · out "+fmt(s.output)+" · hit "+pct(s.hitRatio)+" · busts "+(s.busts||0)+" · errors "+(s.errors||0)+" · last "+ago(s.lastTs);
  var ex=(s.busts?'<span class="chip warn" title="cache busts">'+s.busts+'</span>':'')+(s.errors?'<span class="chip bad" title="errors">'+s.errors+'</span>':'');
  return runRow({st:st,lab:lab,full:full,dotTitle:s.verdict||(recent?"active":"idle"),model:ms[0]||"–",models:ms,w:t,max:max,du:ago(s.lastTs),hit:s.requests?s.hitRatio:null,extra:ex});
 }
 var shown=open?all:all.slice(0,top),rest=all.slice(top),h=shown.map(row).join("");
 if(rest.length){
  var rt=rest.reduce(function(a,s){return a+tot(s)},0);
  h+='<div class="wr-row"><a href="#" class="dim" data-sessmore="'+(open?"0":"1")+'">'+(open?"show fewer sessions":"+"+rest.length+" more sessions ("+fmt(rt)+" tokens)")+'</a></div>';
 }
 return'<div class="wr-group">'+h+'</div>';
}
/** Worker runs grouped under the spawning session: newest run first, groups by their newest run; weighted tokens per run on one scale shared by all rows. */
function workerGroups(ws,W){
 function wt(s){return s.input*W.input+s.cacheWrite*W.cacheWrite+s.cacheRead*W.cacheRead+s.output*W.output}
 var by={},order=[],max=0;
 ws.forEach(function(s){var k=s.workerParent||"other",r={s:s,w:wt(s),start:s.workerStart||0};if(r.w>max)max=r.w;if(!by[k]){by[k]={name:k,runs:[],total:0,newest:0};order.push(by[k])}var g=by[k];g.runs.push(r);g.total+=r.w;if(r.start>g.newest)g.newest=r.start});
 order.forEach(function(g){g.runs.sort(function(a,b){return b.start-a.start})});
 order.sort(function(a,b){return b.newest-a.newest});
 return{groups:order,max:max};
}
var WR_FOLD_KEY="pai.cockpit.wrfold";
function wrFolded(){try{return JSON.parse(localStorage.getItem(WR_FOLD_KEY)||"{}")||{}}catch(e){return{}}}
/** Worker runs: one row per run (status dot, label with the full text in the tooltip, model chip, token bar + number, duration, cache hit%), grouped per spawning session with a fold header. */
function workersHtml(d){
 if(!d.workers.length)return'<span class="dim">no worker sessions in this window</span>';
 var W=d.weights||{input:1,cacheWrite:1.25,cacheRead:.1,output:5},g=workerGroups(d.workers.slice(0,WORKER_ROWS),W),fold=wrFolded(),now=Date.now();
 return g.groups.map(function(grp){
  var shut=!!fold[grp.name],head='<a href="#" class="wr-head" data-wrfold="'+esc(grp.name)+'" title="'+esc(grp.name+" · "+grp.runs.length+(grp.runs.length===1?" run":" runs")+" · "+fmt(grp.total)+" weighted tokens")+'"><span class="wr-car">'+(shut?"▸":"▾")+'</span><b>'+esc(grp.name)+'</b><span class="dim">'+grp.runs.length+(grp.runs.length===1?" run · ":" runs · ")+fmt(grp.total)+'</span></a>';
  if(shut)return'<div class="wr-group">'+head+'</div>';
  return'<div class="wr-group">'+head+grp.runs.map(function(r){var s=r.s,st=String(s.verdict).indexOf("running")===0?"run":vcls(s.verdict);
   var lab=s.name||s.worker,full=lab+" · run "+s.worker+" · "+(s.workerProvider||"-")+" · "+(s.verdict||"worker");
   var du=s.workerStart?dur(((s.workerEnd||now)-s.workerStart)):"–";
   return runRow({st:st,lab:lab,full:full,dotTitle:s.verdict||"worker",model:(s.models&&s.models[0])||"–",models:s.models,w:r.w,max:g.max,du:du,hit:s.requests?s.hitRatio:null});
  }).join("")+'</div>'}).join("");
}
/** Cache verdict by pause: one matrix, a row per model with data, a column per pause bucket, cell "hit% (n)" coloured by hitCls, an empty bucket a dim dot.
 *  Narrow card (pauseFit adds .pm-narrow): the n leaves the cell and stays in its tooltip. */
function pauseHtml(d){
 var ms=d.cachePause.filter(function(cm){return cm.buckets.some(function(b){return b.n})});
 if(!ms.length)return'<span class="dim">no data</span>';
 var st='<style>.pm{width:100%;border-collapse:collapse;font-size:12px}.pm th{color:var(--dim);font-weight:400;text-align:right;padding:2px 6px;white-space:nowrap}.pm td{text-align:right;padding:2px 6px;white-space:nowrap}.pm .pm-m{text-align:left;max-width:0;width:28%;overflow:hidden;text-overflow:ellipsis}.pm-narrow .pm-n{display:none}</style>';
 return'<div class="pm-w">'+st+'<table class="pm"><thead><tr><th class="pm-m">model</th>'+ms[0].buckets.map(function(b){return'<th>'+esc(b.label)+'</th>'}).join("")+'</tr></thead><tbody>'+ms.map(function(cm){
  return'<tr><td class="pm-m" title="'+esc(cm.model)+'">'+esc(cm.model)+'</td>'+cm.buckets.map(function(b){
   if(!b.n)return'<td class="dim">·</td>';
   var hr=b.hit/b.n;
   return'<td title="'+esc(cm.model+" · "+b.label+": "+Math.round(hr*100)+"% hit, "+b.n+" requests")+'"><span class="'+hitCls(hr)+'">'+Math.round(hr*100)+'%</span><span class="pm-n dim"> ('+b.n+')</span></td>'}).join("")+'</tr>'}).join("")+'</tbody></table></div>';
}
/** Below ~420 px the pause matrix drops the n from its cells. */
function pauseFit(ctx){var w=ctx.body.querySelector(".pm-w");if(w)w.classList.toggle("pm-narrow",ctx.body.clientWidth<420)}
function load(){
 feed("data","/cockpit/data?window="+win,["kpis","tokens","cache","speed","pause","sessions","runs","daily"],function(j){newerCheck(j);data=j;Win.update("data",j);winFeedCache()});
}
function loadSystem(){feed("system","/cockpit/system?window="+win,["system","tokens","cache","cloud"],function(j){sys=j;winFeedSystem(j);winFeedCache()})}
`;
