/** cockpit-page — script: donuts, provider tiles, tables, render and load. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** donut through loadSystem. */
export const scriptTables = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`function donut(ratio,sz,tone){
 var r=${n(L.donutRadiusPx)},c=2*Math.PI*r,d=c*ratio;sz=sz||${n(L.donutSizePx)};
 var cx=${n(L.donutViewBoxPx)}/2;
 return'<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 '+${n(L.donutViewBoxPx)}+' '+${n(L.donutViewBoxPx)}+'"><circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="var(--line)" stroke-width="${n(L.donutStrokePx)}"/><circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="'+(tone?"var(--"+tone+")":hitCls(ratio)==="bad"?"var(--bad)":hitCls(ratio)==="warn"?"var(--warn)":"var(--ok)")+'" stroke-width="${n(L.donutStrokePx)}" stroke-dasharray="'+d.toFixed(1)+' '+c.toFixed(1)+'" transform="rotate(-90 '+cx+' '+cx+')"/><text x="'+cx+'" y="'+(sz>120?79:76)+'" text-anchor="middle" style="font-size:'+(sz>120?28:22)+'px;font-weight:600;fill:var(--fg)">'+pct(ratio)+'</text></svg>';
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
/** One tile per provider/model, all the same shape: ring, provider, model + req. Loopback without cache fields: the server prefix-cache ring, else an empty ring. Models under LOW_REQ requests are dimmed, sorted last and never red. */
function ringTiles(ms,servers){
 var list=Object.keys(ms).map(function(k){return ms[k]}).filter(function(m){return m.requests>=LOW_REQ});
 list.sort(function(a,b){var la=a.requests<LOW_REQ?1:0,lb=b.requests<LOW_REQ?1:0;return la!==lb?la-lb:b.requests-a.requests});
 assignColors(list.map(function(m){return m.model}));
 return list.map(function(m){
  var dn=m.cacheRead+m.cacheWrite+m.input,low=m.requests<LOW_REQ,ring,cap="";
  var srv=(servers||[]).filter(function(s){return s.provider===m.provider})[0];
  if(m.cacheRead+m.cacheWrite>0){var r=dn?m.cacheRead/dn:0;ring=low?(r>0?donut(r):emptyRing()):donut(r)}
  else if(srv&&srv.prefixCache&&!low){ring=donut(srv.prefixCache.hitRate);cap='<div class="s" title="Hit rate of the local server\'s own prefix cache (server counter since server start); this provider reports no cache fields per request.">server prefix cache'+ageMark(srv)+'</div>'}
  else{ring=emptyRing();cap='<div class="s">'+(lim?"not reported":'<span class="dim" title="loading: first limits poll pending">…</span>')+'</div>'}
  return'<div class="ring"'+tileAttrs(m.provider+" / "+m.model,ringName(m.model),low?"–":(dn?Math.round(m.cacheRead/dn*100)+"%":"–"))+'>'+tileGrip(ringName(m.model))+ring+'<div class="n">'+esc(ringName(m.model))+'</div><div class="s">'+esc(m.provider)+' · '+m.requests+' req</div>'+cap+'</div>'
 }).join("");
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
/** Cache rings for the c4 card: cloud per model, then per model served by a local server (mapping from /cockpit/system). */
function reuse(prov,pc){return reuseLine(pc,(data.promptByProvider||{})[prov],(data.promptSince||{})[prov])}
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
 var h='<div class="sp"><style>.sp{display:grid;gap:6px 10px;grid-template-columns:minmax(80px,1.1fr) repeat(3,minmax(0,1fr));align-items:center;font-size:12px}.sp>div{min-width:0}.sp-h{color:var(--dim);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sp-n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sp-t{position:relative;height:8px;border-radius:4px;background:var(--line);overflow:hidden}.sp-t i{position:absolute;left:0;top:0;bottom:0;border-radius:4px}.sp-t b{position:absolute;top:3px;height:2px;background:var(--fg);opacity:.55}.sp-l{margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sp-tag{font-size:10px;padding:0 4px;border:1px solid var(--line);border-radius:3px;color:var(--dim);margin-left:4px}</style>'
  +'<div class="sp-h"></div><div class="sp-h" title="Median time from request sent to first content token; the thin line reaches to p90. '+span+'.">Time to first token · '+span+'</div><div class="sp-h" title="Output tokens / decode time, replies of 16+ tokens only. '+span+'.">Output speed · '+span+'</div><div class="sp-h" title="Input tokens / TTFT (prefill incl. cached for local models; Anthropic input excludes cache reads). '+span+'.">Prompt read speed · '+span+'</div>';
 rows.forEach(function(x){
  var r=x.r,s=x.s,loc=localSet&&localSet[r.provider],t=s.ttftP50,t9=s.ttftP90,tt;
  if(num(t)){tt=track('<i style="width:'+pc(t,mT)+'%;background:#3b6fe0"></i>'+(num(t9)&&t9>t?'<b style="left:'+pc(t,mT)+'%;width:'+(pc(t9,mT)-pc(t,mT)).toFixed(1)+'%"></b>':''),sec(t)+(num(t9)?' (p90 '+sec(t9)+')':''),1)}else tt=track('',"–",0);
  h+='<div class="sp-n'+(s.requests?'':' dim')+'" title="'+esc(r.provider+" / "+r.model+" · "+(s.requests||0)+" requests, "+span)+'">'+esc(r.model)+' <span class="dim">'+(s.requests||0)+'</span><span class="sp-tag">'+(loc?"LOCAL":"CLOUD")+'</span></div>'+tt+bar(s.writeTps,mW,"#3bb36f")+bar(s.readTps,mR,"#e0703b");
 });
 return h+'</div>';
}
function renderSpeed(){
 var sp=(data&&data.speed)||[],ls={};
 ((sys&&sys.servers)||[]).forEach(function(s){ls[s.provider]=1});((lim&&lim.limits)||[]).forEach(function(l){if(l.kind==="local")ls[l.provider]=1});
 setHtml($("speed"),sp.length?speedBars(sp,win,ls):'<span class="dim" title="Timing is recorded for streamed replies since the router restart.">no timed requests yet</span>');
}
/** Providers: provider, req, err%, hit% by default; retries, avg ms, ttft p50 and tokens ride in the provider cell's title (retries also as a badge). */
function renderProviders(d){
 setHtml($("providers"),table(["provider .txt","req","err%","hit%"],d.byProvider.map(function(p){var e=p.errors/Math.max(1,p.requests);
  var tt="retries "+p.retries+" · avg "+p.avgMs+" ms · ttft p50 "+(p.ttftP50!=null?fmt(p.ttftP50)+" ms":"-")+" · tokens "+fmt(tot(p));
  return['<span title="'+esc(tt)+'">'+esc(p.provider)+(p.retries?' <span class="warn">↻'+p.retries+'</span>':'')+'</span>',p.requests,'<span class="'+cls(e,ERROR_WARN,ERROR_BAD)+'">'+pct(e)+'</span>',provHit(p,(sys&&sys.servers)||[])]}),{"err%":"Share of requests that failed.","hit%":"cache_read / (read + write + fresh input); * = server counter."})+
  '<div class="dim">Busts: '+(Object.keys(d.bustParts).length?Object.keys(d.bustParts).map(function(k){return esc(k)+" x"+d.bustParts[k]}).join(", "):"none")+'</div><div class="dim">Hover a provider for retries, average ms, TTFT p50 and tokens.</div>');
}
/** Sessions by tokens: name column capped, models as first +N, rows past the top N folded into one expandable row (state in localStorage like folds). */
var SESS_MORE_KEY="pai.cockpit.sessmore";
function sessMore(){try{return localStorage.getItem(SESS_MORE_KEY)==="1"}catch(e){return false}}
function renderSessions(d){
 var el=$("sessions"),all=d.bySession.slice(0,SESSION_ROWS).slice().sort(function(a,b){return tot(b)-tot(a)}),top=${n(L.sessionsTopRows)},open=sessMore();
 function row(s){var nm=s.name?esc(s.name)+' <span class="dim">· '+esc(s.session.slice(0,8))+'</span>':esc(s.session.slice(0,8));var v=s.worker?' <span class="'+vcls(s.verdict)+'" title="worker '+esc(s.worker||"")+'">'+esc(s.verdict||"worker")+'</span>':'';
  var ms=s.models||[],mc=ms.length?esc(ms[0])+(ms.length>1?' <span class="dim">+'+(ms.length-1)+'</span>':''):'';
  return['<span title="'+esc((s.name?s.name+" · ":"")+s.session)+'">'+nm+v+'</span>','<span title="'+esc(ms.join(", "))+'">'+mc+'</span>',s.requests,fmt(tot(s)),fmt(s.input+s.cacheWrite),fmt(s.output),'<span class="'+hitCls(s.hitRatio)+'">'+pct(s.hitRatio)+'</span>','<span class="'+(s.busts?"warn":"")+'">'+s.busts+'</span>',s.errors,ago(s.lastTs)]}
 var shown=open?all:all.slice(0,top),rest=all.slice(top),rows=shown.map(row);
 if(rest.length){
  var rt=rest.reduce(function(a,s){return a+tot(s)},0),blank=function(){return""};
  rows.push(['<a href="#" class="dim" data-sessmore="'+(open?"0":"1")+'">'+(open?"show fewer sessions":"+"+rest.length+" more sessions ("+fmt(rt)+" tokens)")+'</a>'].concat(row(all[0]).slice(1).map(blank)));
 }
 var cap="width:${n(L.sessionNameMaxPct)}%;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
 setHtml(el,table(["session .txt","models .txt","req","tokens","fresh in","out","hit%","busts","errors","last"],rows,null,{"session":cap,"models":"white-space:nowrap"}));
 el.onclick=function(ev){var t=ev.target;while(t&&t!==el&&!(t.getAttribute&&t.getAttribute("data-sessmore")!=null))t=t.parentNode;
  if(!t||t===el)return;ev.preventDefault();try{localStorage.setItem(SESS_MORE_KEY,t.getAttribute("data-sessmore"))}catch(e){}renderSessions(data)};
}
/** Short verdict word from the same verdict string vcls reads; a commit count becomes a "· Nc" suffix. */
function vshort(v){
 if(v==null)return"worker";
 v=String(v);var m=/ · (\d+) commits?$/.exec(v),c=m?" · "+m[1]+"c":"";
 var w=v.indexOf("ok")===0?"ok":v.indexOf("failed")===0?"failed":v.indexOf("report flagged")>=0?"flagged":v.indexOf("escalated")===0?"escalated ↗":v.indexOf("handed")===0?"handed":v.indexOf("running")===0||v.indexOf("waiting")===0?"running":v.indexOf("stopped")===0?"stopped":v.split(/[ :(]/)[0];
 return w+c;
}
/** Worker runs: label (2 lines max, full name in the title); its small dim line is "provider · run id"; verdict as a short word (full text in the title); tokens. */
function renderWorkers(d){
 setHtml($("workers"),d.workers.length?table(["label .txt","verdict","tokens"],d.workers.slice(0,WORKER_ROWS).map(function(s){
  var lab=esc(s.name||s.worker),sub=esc((s.workerProvider||"-")+" · "+s.worker.slice(0,9)+"…");
  var full=(s.name?s.name+" · ":"")+"run "+s.worker+" · "+(s.workerProvider||"-");
  return['<span class="cell2" title="'+esc(full)+'">'+(s.name?'<span class="l1">'+lab+'</span>':'')+'<small class="dim l2">'+sub+'</small></span>','<span class="'+vcls(s.verdict)+'" title="'+esc(s.verdict||"worker")+'">'+esc(vshort(s.verdict))+'</span>',fmt(tot(s))]
 }),{"tokens":"Total tokens of the run."},{"label":"max-width:0"}):'<span class="dim">no worker sessions in this window</span>');
}
function renderDonuts(){ renderSpeed();
 if(!data)return;var d=data,t=d.totals,ms={};
 d.byModel.forEach(function(m){var k=m.provider+"\u0000"+m.model,o=ms[k]||(ms[k]={provider:m.provider,model:m.model,cacheRead:0,cacheWrite:0,input:0,requests:0});o.cacheRead+=m.cacheRead;o.cacheWrite+=m.cacheWrite;o.input+=m.input;o.requests+=m.requests});
 var mk=Object.keys(ms),dh="",allSrv2=(sys&&sys.servers)||[];
 if(mk.length===1&&ms[mk[0]].cacheRead+ms[mk[0]].cacheWrite>0){var m=ms[mk[0]],dn=m.cacheRead+m.cacheWrite+m.input;
  dh='<div class="solo">'+donut(dn?m.cacheRead/dn:0,${L.bigDonutSizePx})+'<div class="bignum">'+pct(t.hitRatio)+'<span>overall hit ratio</span><span>'+esc(m.provider)+' · '+esc(m.model)+' · '+m.requests+' req</span></div></div>';
 }else{dh=ringTiles(ms,allSrv2);if(dh)dh='<div class="tset" data-tkey="rings">'+dh+'</div>'}
 var lowc=dh.indexOf('class="solo"')>=0?"":lowChips(ms);
 setHtml($("donut"),dh||(lowc?"":'<span class="dim">no data</span>'));
 orderTiles($("donut"));
 setHtml($("donutlow"),lowc);
 function chip(l,v,tt){return'<span class="chip"'+(tt?' title="'+esc(tt)+'"':'')+'>'+l+' <b>'+v+'</b></span>'}
 var note=chip("overall",pct(t.hitRatio),"cache_read / (read + write + fresh input), all providers and models");
 var sk=d.sessionSplit;
 if(sk)note+=chip("continuous",pct(sk.continuous.hitRatio)+" ("+sk.continuous.sessions+" sess)","continuous sessions: "+sk.continuous.sessions+" sessions, "+sk.continuous.requests+" requests")+chip("one-shot",pct(sk.oneShot.hitRatio)+" ("+sk.oneShot.sessions+" sess)","one-shot sessions: "+sk.oneShot.sessions+" sessions, "+sk.oneShot.requests+" requests");
 if(d.pool&&d.pool.tasks)note+=chip("pool",d.pool.tasks+" task(s) · "+fmt(d.pool.tokensCarried),d.pool.tasks+" task(s), "+fmt(d.pool.tokensCarried)+" tokens carried");
 setHtml($("donutnote"),note);
 var loc=(sys&&sys.servers||[]).filter(function(s){return s.up!==false});
 var lh="";
 loc.forEach(function(s){if(s.prefixCache)lh+=localDetail(s.provider,s.prefixCache,(data.promptByProvider||{})[s.provider],ageMark(s))});
 $("donutlocaltitle").style.display=lh?"":"none";
 setHtml($("donutlocal"),lh);
}
function render(){
 if(!data)return;var d=data,t=d.totals;
 setHtml($("kpis"),'<div class="tset" data-tkey="kpis">'+[["requests",fmt(t.requests)],["input",fmt(t.input)],["output",fmt(t.output)],["cache read",fmt(t.cacheRead)],["cache write",fmt(t.cacheWrite)],["errors",'<span class="'+cls(t.errors/Math.max(1,t.requests),ERROR_WARN,ERROR_BAD)+'">'+t.errors+'</span>']].map(function(k){return'<div class="kpi"'+tileAttrs(k[0],k[0],k[1].replace(/<[^>]*>/g,""))+'>'+tileGrip(k[0])+'<b>'+k[1]+'</b><span>'+k[0]+'</span></div>'}).join("")+'</div>');
 orderTiles($("kpis"));
 var models=[];d.byModel.forEach(function(m){if(models.indexOf(m.model)<0)models.push(m.model)});models.sort();
 assignColors(models);
 var sel=$("msel");if(msel&&models.indexOf(msel)<0)msel="";
 setHtml(sel,'<option value="">all models</option>'+models.map(function(m){return'<option'+(m===msel?' selected':'')+'>'+esc(m)+'</option>'}).join(""));
 sel.onchange=function(){msel=this.value;render()};
 var W=d.weights||{input:1,cacheWrite:1.25,cacheRead:.1,output:5},wt=mode==="weighted";
 var series=d.series.map(function(b){var o={};KINDS.forEach(function(k){o[k[0]]=0});Object.keys(b.models).forEach(function(m){if(msel&&m!==msel)return;KINDS.forEach(function(k){o[k[0]]+=(b.models[m][k[0]]||0)*(wt?W[k[0]]:1)})});return o});
 var buckets=d.series.map(function(b){var arr=[];models.forEach(function(m){var v=b.models[m];if(!v)return;var o={model:m,requests:v.requests||0};KINDS.forEach(function(k){o[k[0]]=(v[k[0]]||0)*(wt?W[k[0]]:1)});o.total=tot(o);if(o.total>0)arr.push(o)});return arr});
 var labs=d.series.map(function(b){return label(b.t,d.window)});
 var gap=msel?stackedBars($("series"),labs,series,KINDS.map(function(k){return k[0]}),${L.tokensChartWidthPx},${L.tokensChartHeightPx}):twoToneModelBars($("series"),labs,buckets,models,${L.tokensChartWidthPx},${L.tokensChartHeightPx});
 chartCap($("seriescap"),gap);
 setHtml($("legend"),legendLine("kinds",KINDS.map(function(k){return'<span><i style="background:'+k[2]+'"></i>'+k[1]+(wt?' x'+W[k[0]]:'')+'</span>'}).join("")+(msel?"":'<span><i style="background:'+colorOf("input")+';opacity:.25"></i>total (light)</span><span><i style="background:'+colorOf("input")+'"></i>non-cached (solid)</span>')+(msel?"":legendLine("models",models.map(function(m){return'<span><i style="background:'+colorOf(m)+'"></i>'+esc(ringName(m))+'</span>'}).join(""))))+(msel?"":"</div>"));
 setTip($("wnote"),wt?"Weighted: tokens times Anthropic price ratios relative to fresh input (cache read "+W.cacheRead+", cache write "+W.cacheWrite+", output "+W.output+"). The same ratios are applied to every other provider, whatever its real prices.":"Raw: token counts as reported.");
 var mb=document.querySelectorAll("#mode button");for(var i=0;i<mb.length;i++){mb[i].className=mb[i].getAttribute("data-m")===mode?"on":"";mb[i].onclick=function(){mode=this.getAttribute("data-m");localStorage.setItem("cockpitMode",mode);render()}}
 renderDonuts();
 var ph=d.cachePause.map(function(cm){
  return[esc(cm.model)].concat(cm.buckets.map(function(b){if(!b.n)return'<span class="dim">-</span>';var hr=b.hit/b.n;return'<span class="'+hitCls(hr)+'">'+Math.round(hr*100)+'%</span> <span class="dim">'+b.n+'</span>'}));
 });
 setHtml($("pause"),ph.length?table(["model (hit% n) .txt"].concat(d.cachePause[0].buckets.map(function(b){return b.label})),ph):'<span class="dim">no data</span>');
 renderProviders(d);renderSessions(d);renderWorkers(d);
 var dm=Object.keys(d.daily.models),dd=d.daily.days.slice(-DAILY_DAYS),ds=dd.map(function(t,i){var o={};dm.forEach(function(m){o[m]=d.daily.models[m][d.daily.days.length-dd.length+i]});return o});
 // one assignment over the union of every model shown anywhere on the page (window, daily, rings, speed):
 // a chart with a smaller model set must not wipe the colours of the models another chart shows
 var um={},ui;models.forEach(function(m){um[m]=1});dm.forEach(function(m){um[m]=1});
 d.byModel.forEach(function(m){um[m.model]=1});(d.speed||[]).forEach(function(r){um[r.model]=1});
 assignColors(Object.keys(um));
 var dgap=stackedBars($("daily"),dd.map(function(t){return new Date(t).toLocaleDateString([],{day:"numeric",month:"numeric"})}),ds,dm,${L.dailyChartWidthPx},${L.dailyChartHeightPx});
 chartCap($("dailycap"),dgap);
 legend($("dlegend"),dm);
}
function load(){
 feed("data","/cockpit/data?window="+win,["kpis","tokens","cache","speed","pause","sessions","runs","daily"],function(j){data=j;render()});
}
function loadSystem(){feed("system","/cockpit/system?window="+win,["system","tokens","cache","cloud"],function(j){sys=j;renderSystem();renderPower();renderDonuts()})}
`;
