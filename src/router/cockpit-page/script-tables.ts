/** cockpit-page — script: donuts, provider tiles, tables, render and load. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** donut through loadSystem. */
export const scriptTables = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`function donut(ratio,sz){
 var r=${n(L.donutRadiusPx)},c=2*Math.PI*r,d=c*ratio;sz=sz||${n(L.donutSizePx)};
 var cx=${n(L.donutViewBoxPx)}/2;
 return'<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 '+${n(L.donutViewBoxPx)}+' '+${n(L.donutViewBoxPx)}+'"><circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="var(--line)" stroke-width="${n(L.donutStrokePx)}"/><circle cx="'+cx+'" cy="'+cx+'" r="'+r+'" fill="none" stroke="'+(hitCls(ratio)==="bad"?"var(--bad)":hitCls(ratio)==="warn"?"var(--warn)":"var(--ok)")+'" stroke-width="${n(L.donutStrokePx)}" stroke-dasharray="'+d.toFixed(1)+' '+c.toFixed(1)+'" transform="rotate(-90 '+cx+' '+cx+')"/><text x="'+cx+'" y="'+(sz>120?79:76)+'" text-anchor="middle" style="font-size:'+(sz>120?28:22)+'px;font-weight:600;fill:var(--fg)">'+pct(ratio)+'</text></svg>';
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
  return'<div class="ring">'+ring+'<div class="n">'+esc(ringName(m.model))+'</div><div class="s">'+esc(m.provider)+' · '+m.requests+' req</div>'+cap+'</div>'
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
/** One box for every table: a wide table scrolls inside .tw (theme-coloured thin
 *  scrollbar, sticky first column); below the phone breakpoint CSS turns each row
 *  into a stacked card — the column label rides on each cell as data-l. */
function table(head,rows,tips){return'<div class="tw"><table><thead><tr>'+head.map(function(h){return'<th'+(tips&&tips[h]?' title="'+esc(tips[h])+'"':'')+'>'+h+'</th>'}).join("")+'</tr></thead><tbody>'+rows.map(function(r){return'<tr>'+r.map(function(c,i){return'<td data-l="'+esc(head[i]||"")+'">'+c+'</td>'}).join("")+'</tr>'}).join("")+'</tbody></table></div>'}
/** Verdict colour by prefix: ok* green, failed red, "report flagged" and an escalated hand-off amber, the rest dim.
 *  A missing verdict is dim, never a crash. One helper for both verdict tables. */
function vcls(v){return v==null?"dim":String(v).indexOf("ok")===0?"ok":String(v).indexOf("failed")===0?"bad":String(v).indexOf("report flagged")>=0||String(v).indexOf("escalated")===0||String(v).indexOf("handed to session")===0?"warn":"dim"}
/** Cache rings for the c4 card: cloud per model, then per model served by a local server (mapping from /cockpit/system). */
function reuse(prov,pc){return reuseLine(pc,(data.promptByProvider||{})[prov],(data.promptSince||{})[prov])}
function renderSpeed(){
 var sp=(data&&data.speed)||[];
 function c(st,k,u){return st[k]==null?'<span class="dim">-</span>':fmt(st[k])+u}
 setHtml($("speed"),sp.length?table(["provider","model","req 1h / 24h","TTFT p50 1h","p90 1h","TTFT p50 24h","p90 24h","read tok/s 1h","24h","write tok/s 1h","24h"],sp.map(function(r){return[esc(r.provider),esc(r.model),r.h1.requests+" / "+r.h24.requests,c(r.h1,"ttftP50"," ms"),c(r.h1,"ttftP90"," ms"),c(r.h24,"ttftP50"," ms"),c(r.h24,"ttftP90"," ms"),c(r.h1,"readTps",""),c(r.h24,"readTps",""),c(r.h1,"writeTps",""),c(r.h24,"writeTps","")]}),{"TTFT p50 1h":"Median time from request sent to first content token, last hour.","TTFT p50 24h":"Median time from request sent to first content token, last 24 hours.","p90 1h":"90th percentile TTFT, last hour.","p90 24h":"90th percentile TTFT, last 24 hours.","read tok/s 1h":"Input tokens / TTFT (prefill incl. cached for local models; Anthropic input excludes cache reads).","write tok/s 1h":"Output tokens / decode time, replies of 16+ tokens only."}):'<span class="dim" title="Timing is recorded for streamed replies since the router restart.">no timed requests yet</span>');
}
function renderDonuts(){ renderSpeed();
 if(!data)return;var d=data,t=d.totals,ms={};
 d.byModel.forEach(function(m){var k=m.provider+"\u0000"+m.model,o=ms[k]||(ms[k]={provider:m.provider,model:m.model,cacheRead:0,cacheWrite:0,input:0,requests:0});o.cacheRead+=m.cacheRead;o.cacheWrite+=m.cacheWrite;o.input+=m.input;o.requests+=m.requests});
 var mk=Object.keys(ms),dh="",allSrv2=(sys&&sys.servers)||[];
 if(mk.length===1&&ms[mk[0]].cacheRead+ms[mk[0]].cacheWrite>0){var m=ms[mk[0]],dn=m.cacheRead+m.cacheWrite+m.input;
  dh='<div class="solo">'+donut(dn?m.cacheRead/dn:0,${L.bigDonutSizePx})+'<div class="bignum">'+pct(t.hitRatio)+'<span>overall hit ratio</span><span>'+esc(m.provider)+' · '+esc(m.model)+' · '+m.requests+' req</span></div></div>';
 }else dh=ringTiles(ms,allSrv2);
 var lowc=dh.indexOf('class="solo"')>=0?"":lowChips(ms);
 setHtml($("donut"),dh||(lowc?"":'<span class="dim">no data</span>'));
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
 setHtml($("kpis"),[["requests",fmt(t.requests)],["input",fmt(t.input)],["output",fmt(t.output)],["cache read",fmt(t.cacheRead)],["cache write",fmt(t.cacheWrite)],["errors",'<span class="'+cls(t.errors/Math.max(1,t.requests),ERROR_WARN,ERROR_BAD)+'">'+t.errors+'</span>']].map(function(k){return'<div class="kpi"><b>'+k[1]+'</b><span>'+k[0]+'</span></div>'}).join(""));
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
 setHtml($("pause"),ph.length?table(["model (hit% n)"].concat(d.cachePause[0].buckets.map(function(b){return b.label})),ph):'<span class="dim">no data</span>');
 setHtml($("providers"),table(["provider","req","err%","retries","avg ms","ttft p50","hit%","tokens"],d.byProvider.map(function(p){var e=p.errors/Math.max(1,p.requests);return[esc(p.provider),p.requests,'<span class="'+cls(e,ERROR_WARN,ERROR_BAD)+'">'+pct(e)+'</span>','<span class="'+(p.retries?"warn":"")+'">'+p.retries+'</span>',p.avgMs,p.ttftP50!=null?fmt(p.ttftP50)+' ms':'<span class="dim">-</span>',provHit(p,(sys&&sys.servers)||[]),fmt(tot(p))]}),{"avg ms":"Average end-to-end milliseconds incl. queueing and prefill.","ttft p50":"Median time from request sent to first token.","retries":"Retried upstream calls.","hit%":"cache_read / (read + write + fresh input); * = server counter."})+
  '<div class="dim">Busts: '+(Object.keys(d.bustParts).length?Object.keys(d.bustParts).map(function(k){return esc(k)+" x"+d.bustParts[k]}).join(", "):"none")+'</div>');
 setHtml($("sessions"),table(["session","models","req","tokens","fresh in","out","hit%","busts","errors","last"],d.bySession.slice(0,SESSION_ROWS).map(function(s){var nm=s.name?esc(s.name)+' <span class="dim">· '+esc(s.session.slice(0,8))+'</span>':esc(s.session.slice(0,8));var v=s.worker?' <span class="'+vcls(s.verdict)+'" title="worker '+esc(s.worker||"")+'">'+esc(s.verdict||"worker")+'</span>':'';return['<span title="'+esc(s.session)+'">'+nm+v+'</span>',esc(s.models.join(", ")),s.requests,fmt(tot(s)),fmt(s.input+s.cacheWrite),fmt(s.output),'<span class="'+hitCls(s.hitRatio)+'">'+pct(s.hitRatio)+'</span>','<span class="'+(s.busts?"warn":"")+'">'+s.busts+'</span>',s.errors,ago(s.lastTs)]})));
 setHtml($("workers"),d.workers.length?table(["worker","label","provider","req","tokens","verdict"],d.workers.slice(0,WORKER_ROWS).map(function(s){return[esc(s.worker),esc(s.name||"-"),esc(s.workerProvider||"-"),s.requests,fmt(tot(s)),'<span class="'+vcls(s.verdict)+'">'+esc(s.verdict||"worker")+'</span>']})):'<span class="dim">no worker sessions in this window</span>');
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
 fetch("/cockpit/data?window="+win,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){data=j;lastOk=Date.now();render()}).catch(function(){});
}
function loadSystem(){fetch("/cockpit/system?window="+win,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){sys=j;lastOk=Date.now();renderSystem();renderPower();renderDonuts()}).catch(function(){})}
`;
