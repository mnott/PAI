/** cockpit-page/win — B10 `cache`: the "Cache hit ratio" group on the win runtime (spec 7/B10).
 *  Page-scope ES5 (after scriptCore/scriptTables: esc/fmt/pct/table/donut/emptyRing/lowChips/localDetail/ageMark/
 *  provHit/ringName/assignColors/LOW_REQ in scope), needs `Win` and `WinT`. Feed `cache` = {data, sys, lim} (the page's
 *  /cockpit/data, /cockpit/system and /cockpit/limits readings, pushed by winFeedCache after every renderDonuts).
 *  Group `cache`, a column of: the group `cache-rings` (one `ring` card per model with enough requests, or the single
 *  big-donut `cache.solo`, or `cache.none`), the `chips` cards `cache.low` and `cache.note`, the `cache-list` card
 *  `cache.local` ("Local prefix cache") and the `cache-table` card `cache.providers`. */

export const WIN_CACHE_JS = String.raw`var CACHE_INFO="cache_read / (read + write + fresh input), per provider / model.";
var CACHE_LOCAL_INFO="Server counters cover the time since that server started; router log rows only since the router restarted, so the two windows differ. A hit skips re-computing the cached prompt part (latency), not money.";
var CACHE_PROV_INFO="* server counter (prefix cache since server start; this provider reports no cache fields per request). avg ms is end-to-end incl. queueing and prefill, ttft p50 is time to first token.";
var CACHE_BIG=170,CACHE_RING_ROW=4,CACHE_IDS=null;
/** The window's models merged over providers: {provider\0model: {provider,model,cacheRead,cacheWrite,input,requests}}. */
function cacheModels(d){
 var ms={};
 d.byModel.forEach(function(m){var k=m.provider+"\u0000"+m.model,o=ms[k]||(ms[k]={provider:m.provider,model:m.model,cacheRead:0,cacheWrite:0,input:0,requests:0});o.cacheRead+=m.cacheRead;o.cacheWrite+=m.cacheWrite;o.input+=m.input;o.requests+=m.requests});
 return ms;
}
/** The one model of a solo big donut (a single model with cache fields), else null. */
function cacheSolo(ms){
 var mk=Object.keys(ms);
 return mk.length===1&&ms[mk[0]].cacheRead+ms[mk[0]].cacheWrite>0?ms[mk[0]]:null;
}
/** Models with at least LOW_REQ requests, most requests first (the others ride in the low chip). */
function cacheRingList(ms){
 var list=Object.keys(ms).map(function(k){return ms[k]}).filter(function(m){return m.requests>=LOW_REQ});
 list.sort(function(a,b){return b.requests-a.requests});
 return list;
}
function cacheRingId(m){return"cache.ring:"+m.provider+"/"+m.model}
/** The card ids the rings group should hold for this data: the solo card, a ring per model, or the empty note. */
function cacheRingIds(d){
 var ms=cacheModels(d);
 if(cacheSolo(ms))return["cache.solo"];
 var l=cacheRingList(ms);
 return l.length?l.map(cacheRingId):["cache.none"];
}
/** The ring and caption of one model: its own cache fields, else the local server's prefix-cache counter, else an empty ring. */
function cacheRingHtml(m,servers,lim0){
 var dn=m.cacheRead+m.cacheWrite+m.input,ring,cap="";
 var srv=(servers||[]).filter(function(s){return s.provider===m.provider})[0];
 if(m.cacheRead+m.cacheWrite>0)ring=donut(dn?m.cacheRead/dn:0);
 else if(srv&&srv.prefixCache){ring=donut(srv.prefixCache.hitRate);cap='<div class="s" title="Hit rate of the local server\'s own prefix cache (server counter since server start); this provider reports no cache fields per request.">server prefix cache'+ageMark(srv)+'</div>'}
 else{ring=emptyRing();cap='<div class="s">'+(lim0?"not reported":'<span class="dim" title="loading: first limits poll pending">…</span>')+'</div>'}
 return'<div class="ring">'+ring+'<div class="n">'+esc(ringName(m.model))+'</div><div class="s">'+esc(m.provider)+' · '+m.requests+' req</div>'+cap+'</div>';
}
function cacheSoloHtml(m,t){
 var dn=m.cacheRead+m.cacheWrite+m.input;
 return'<div class="solo">'+donut(dn?m.cacheRead/dn:0,CACHE_BIG)+'<div class="bignum">'+pct(t.hitRatio)+'<span>overall hit ratio</span><span>'+esc(m.provider)+' · '+esc(m.model)+' · '+m.requests+' req</span></div></div>';
}
function cacheChip(l,v,tt){return'<span class="chip"'+(tt?' title="'+esc(tt)+'"':'')+'>'+l+' <b>'+v+'</b></span>'}
/** overall / continuous / one-shot / pool chips. */
function cacheNoteHtml(d){
 var t=d.totals,sk=d.sessionSplit,n=cacheChip("overall",pct(t.hitRatio),"cache_read / (read + write + fresh input), all providers and models");
 if(sk)n+=cacheChip("continuous",pct(sk.continuous.hitRatio)+" ("+sk.continuous.sessions+" sess)","continuous sessions: "+sk.continuous.sessions+" sessions, "+sk.continuous.requests+" requests")+cacheChip("one-shot",pct(sk.oneShot.hitRatio)+" ("+sk.oneShot.sessions+" sess)","one-shot sessions: "+sk.oneShot.sessions+" sessions, "+sk.oneShot.requests+" requests");
 if(d.pool&&d.pool.tasks)n+=cacheChip("pool",d.pool.tasks+" task(s) · "+fmt(d.pool.tokensCarried),d.pool.tasks+" task(s), "+fmt(d.pool.tokensCarried)+" tokens carried");
 return n;
}
/** One line per up local server with a prefix cache. */
function cacheLocalHtml(d,sys0){
 var lh="";
 ((sys0&&sys0.servers)||[]).filter(function(s){return s.up!==false}).forEach(function(s){if(s.prefixCache)lh+=localDetail(s.provider,s.prefixCache,(d.promptByProvider||{})[s.provider],ageMark(s))});
 return lh;
}
function cacheProvidersHtml(d,sys0){
 return table(["provider .txt","req","err%","hit%"],d.byProvider.map(function(p){var e=p.errors/Math.max(1,p.requests);
  var tt="retries "+p.retries+" · avg "+p.avgMs+" ms · ttft p50 "+(p.ttftP50!=null?fmt(p.ttftP50)+" ms":"-")+" · tokens "+fmt(tot(p));
  return['<span title="'+esc(tt)+'">'+esc(p.provider)+(p.retries?' <span class="warn">↻'+p.retries+'</span>':'')+'</span>',p.requests,'<span class="'+cls(e,ERROR_WARN,ERROR_BAD)+'">'+pct(e)+'</span>',provHit(p,(sys0&&sys0.servers)||[])]}),{"err%":"Share of requests that failed.","hit%":"cache_read / (read + write + fresh input); * = server counter."})+
  '<div class="dim">Busts: '+(Object.keys(d.bustParts).length?Object.keys(d.bustParts).map(function(k){return esc(k)+" x"+d.bustParts[k]}).join(", "):"none")+'</div><div class="dim">Hover a provider for retries, average ms, TTFT p50 and tokens.</div>';
}
/** The ring card of one model (id cache.ring:<provider>/<model>), the big donut (cache.solo) or the empty note (cache.none). */
Win.registerType("ring",{minW:120,minH:130,defaultH:150,
 mount:function(ctx){ctx.body.innerHTML='<div class="wm" style="text-align:center"><div data-k="r"></div></div>'},
 update:function(ctx,p){
  if(!p||!p.data)return;
  var d=p.data,ms=cacheModels(d),id=ctx.id,m,k;
  if(id==="cache.none"){ctx.html("r",'<span class="dim">no data</span>');return}
  if(id==="cache.solo"){m=cacheSolo(ms);if(m){ctx.title("Cache hit ratio");ctx.html("r",cacheSoloHtml(m,d.totals))}return}
  k=id.slice(11);m=ms[k.replace("/","\u0000")];
  if(!m){ctx.html("r",'<span class="dim">no requests in this window</span>');return}
  ctx.title(ringName(m.model));
  ctx.html("r",cacheRingHtml(m,(p.sys&&p.sys.servers)||[],p.lim));
 }});
/** chips: cache.low = the models under LOW_REQ requests, cache.note = overall/continuous/one-shot/pool. */
Win.registerType("chips",{minW:160,minH:48,defaultH:60,
 mount:function(ctx){ctx.body.innerHTML='<div class="wm chips" data-k="c"></div>'},
 update:function(ctx,p){
  if(!p||!p.data)return;
  if(ctx.id==="cache.low"){ctx.html("c",lowChips(cacheModels(p.data))||'<span class="dim">no low-request models</span>');return}
  ctx.html("c",cacheNoteHtml(p.data));
 }});
Win.registerType("cache-list",{minW:200,minH:60,defaultH:90,
 mount:function(ctx){ctx.body.innerHTML='<div class="wm" data-k="l"></div>'},
 update:function(ctx,p){
  if(!p||!p.data)return;
  ctx.html("l",cacheLocalHtml(p.data,p.sys)||'<span class="dim">no local server reports a prefix cache</span>');
 }});
Win.registerType("cache-table",{minW:300,minH:80,defaultH:160,
 mount:function(ctx){ctx.body.innerHTML='<div class="tw" data-k="t"></div>'},
 update:function(ctx,p){
  if(!p||!p.data)return;
  ctx.html("t",cacheProvidersHtml(p.data,p.sys));
 }});
function cacheRows(ids){var rows=[],i;for(i=0;i<ids.length;i+=CACHE_RING_ROW)rows.push(ids.slice(i,i+CACHE_RING_ROW));return rows}
/** The rings group's kids: rows of at most CACHE_RING_ROW rings. */
function cacheRingTree(ids){
 var rows=cacheRows(ids).map(function(r){return r.length===1?WinT.leaf(r[0]):WinT.split("r",r.map(WinT.leaf),r.map(function(){return 1/r.length}))});
 return rows.length===1?rows[0]:WinT.split("c",rows,rows.map(function(){return 1/rows.length}));
}
/** A structural change: when the set of ring cards differs, build the missing ones and swap the group's kids. */
function cacheSync(p){
 if(!p||!p.data||!p.data.byModel)return;
 var ids=cacheRingIds(p.data),key=ids.join("\n");
 if(key===CACHE_IDS)return;
 var specs=ids.map(function(id){return{id:id,type:"ring",title:id==="cache.none"||id==="cache.solo"?"Cache hit ratio":id.slice(11).split("/").slice(1).join("/"),feeds:["cache"]}});
 Win.addCards("cache-rings",specs,cacheRows(ids));
 Win.apply("cache-rings",cacheRingTree(ids));
 CACHE_IDS=key;
}
/** The page's readings as the cache feed; called after every renderDonuts. */
function winFeedCache(){
 if(!data)return;
 var p={data:data,sys:sys,lim:lim};
 cacheSync(p);Win.update("cache",p);
}
function cacheDefaults(){
 var cards=[{id:"cache",type:"group",title:"Cache hit ratio",info:CACHE_INFO},{id:"cache-rings",type:"group",title:"Hit ratio per model"},
  {id:"cache.none",type:"ring",title:"Cache hit ratio",feeds:["cache"]},
  {id:"cache.low",type:"chips",title:"low-request models",feeds:["cache"]},{id:"cache.note",type:"chips",title:"totals",feeds:["cache"]},
  {id:"cache.local",type:"cache-list",title:"Local prefix cache",info:CACHE_LOCAL_INFO,feeds:["cache"]},
  {id:"cache.providers",type:"cache-table",title:"Providers",info:CACHE_PROV_INFO,feeds:["cache"]}];
 var chips=WinT.split("r",[WinT.leaf("cache.low"),WinT.leaf("cache.note")],[0.5,0.5]);
 return{tree:WinT.leaf("cache"),kids:{cache:WinT.split("c",[WinT.leaf("cache-rings"),chips,WinT.leaf("cache.local"),WinT.leaf("cache.providers")],[0.32,0.12,0.16,0.4]),"cache-rings":WinT.leaf("cache.none")},stDefaults:{},cards:cards};
}
`;
