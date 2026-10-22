/** cockpit-page/win — B10 `cache`: the "Cache hit ratio" group on the win runtime (spec 7/B10).
 *  Page-scope ES5 (after scriptCore/scriptTables: esc/fmt/pct/table/donut/emptyRing/lowChips/localDetail/ageMark/
 *  provHit/ringName/assignColors/LOW_REQ in scope), needs `Win` and `WinT`. Feed `cache` = {data, sys, lim} (the page's
 *  /cockpit/data, /cockpit/system and /cockpit/limits readings, pushed by winFeedCache after every renderDonuts).
 *  Group `cache`, a column of: the group `cache-rings` (one `ring` card per model, the low-request ones small and dimmed, or the single
 *  big-donut `cache.solo`, or `cache.none`), the `chips` card `cache.note`, the `list` card
 *  `cache.local` ("Local prefix cache") and the `table` card `cache.providers`. */

export const WIN_CACHE_JS = String.raw`var CACHE_INFO="cache_read / (read + write + fresh input), per provider / model. Models with fewer than "+LOW_REQ+" requests in the window are shown small and dimmed: their hit ratio is noisy.";
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
/** True when some model has enough requests: only then the low-request ones are shown small and dimmed. */
function cacheHasNormal(ms){return Object.keys(ms).some(function(k){return ms[k].requests>=LOW_REQ})}
/** THE order of per-model rows (hit rings and speed rows): provider (routing order, then alphabetical), normal before low-request, most requests first, then model name. x: {provider, model, requests}. */
function providerModelCmp(a,b){
 var ch=(lim&&lim.routing&&lim.routing.choices)||[],rank={};
 ch.forEach(function(c,i){if(rank[c.entry]===undefined)rank[c.entry]=i});
 function r(p){return rank[p]===undefined?1e9:rank[p]}
 function lo(m){return(m.requests||0)<LOW_REQ?1:0}
 return r(a.provider)-r(b.provider)||(a.provider<b.provider?-1:a.provider>b.provider?1:0)||lo(a)-lo(b)||(b.requests||0)-(a.requests||0)||(a.model<b.model?-1:a.model>b.model?1:0);
}
/** All models in the default order: provider (routing order, then alphabetical), normal before low-request, most requests first. */
function cacheRingList(ms,d){
 var list=Object.keys(ms).map(function(k){return ms[k]});
 list.sort(providerModelCmp);
 return list;
}
function cacheRingId(m){return"cache.ring:"+m.provider+"/"+m.model}
var CACHE_ORDER_KEY="cockpitRingOrder",CACHE_APPLIED=null;
/** The user's stored ring order (ids), or null while they never dragged a ring. */
function cacheUserOrder(){try{var o=JSON.parse(localStorage.getItem(CACHE_ORDER_KEY)||"null");return o&&o.length?o:null}catch(e){return null}}
function cacheSetUserOrder(o){try{if(o)localStorage.setItem(CACHE_ORDER_KEY,JSON.stringify(o));else localStorage.removeItem(CACHE_ORDER_KEY)}catch(e){}}
/** The ring ids in the order the rings group shows them now (tree order), only ring cards. */
function cacheTreeIds(t){return!t?[]:t.k==="c"?[t.id]:t.ch.reduce(function(a,c){return a.concat(cacheTreeIds(c))},[])}
/** The stored order wins; ids it does not know sit at their default slot (after the nearest default predecessor already placed). */
function cacheMerge(def,user){
 if(!user)return def;
 var out=user.filter(function(id){return def.indexOf(id)>=0}),i,j,at;
 for(i=0;i<def.length;i++){
  if(out.indexOf(def[i])>=0)continue;
  at=0;
  for(j=i-1;j>=0;j--){var q=out.indexOf(def[j]);if(q>=0){at=q+1;break}}
  out.splice(at,0,def[i]);
 }
 return out;
}
/** The card ids the rings group should hold for this data: the solo card, a ring per model, or the empty note. */
function cacheRingIds(d){
 var ms=cacheModels(d);
 if(cacheSolo(ms))return["cache.solo"];
 var l=cacheRingList(ms,d);
 return l.length?cacheMerge(l.map(cacheRingId),cacheUserOrder()):["cache.none"];
}
/** The ring and caption of one model: its own cache fields, else the local server's prefix-cache counter, else an empty ring. */
function cacheRingHtml(m,servers,lim0,low){
 var dn=m.cacheRead+m.cacheWrite+m.input,ring,cap="";
 var srv=(servers||[]).filter(function(s){return s.provider===m.provider})[0];
 if(m.cacheRead+m.cacheWrite>0)ring=donut(dn?m.cacheRead/dn:0);
 else if(srv&&srv.prefixCache){ring=donut(srv.prefixCache.hitRate);cap='<div class="s" title="Hit rate of the local server\'s own prefix cache (server counter since server start); this provider reports no cache fields per request.">server prefix cache'+ageMark(srv)+'</div>'}
 else{ring=emptyRing();cap='<div class="s">'+(lim0?"not reported":'<span class="dim" title="loading: first limits poll pending">…</span>')+'</div>'}
 return'<div class="ring'+(low?' low':'')+'"'+(low?' title="fewer than '+LOW_REQ+' requests in this window: the hit ratio is noisy"':'')+'>'+ring+'<div class="n">'+esc(ringName(m.model))+'</div><div class="s">'+esc(m.provider)+' · '+m.requests+' req'+(low?' · few requests':'')+'</div>'+cap+'</div>';
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
/** One row per up local server with a prefix cache: hit-ratio bar (hits/(hits+misses), "–" with no requests), tokens saved as a bar of the router's prompt tokens, entries and size dim. */
function cachePrefixRow(s,tot){
 var pc=s.prefixCache,n=pc.hits+pc.misses,r=n?pc.hits/n:0,tone=hitCls(r)==="bad"?"bad":hitCls(r)==="warn"?"warn":"ok";
 var sv=tot?Math.min(1,pc.tokensSaved/tot):0,gb=pc.memoryMb!=null?(pc.memoryMb>=1024?(pc.memoryMb/1024).toFixed(1)+" GB":Math.round(pc.memoryMb)+" MB"):"";
 var mem=(pc.entries!=null?pc.entries+" entries":"")+(pc.entries!=null&&gb?" / ":"")+gb;
 return'<div class="pcrow"><b class="pcn">'+(esc(s.provider)+ageMark(s))+'</b>'+
  '<span class="pcc" title="Prefix-cache hit ratio (server counter since server start)">'+(n?'<span class="pct"><i class="bar" style="width:'+Math.round(r*100)+'%;background:var(--'+tone+')"></i></span> <span class="'+tone+'">'+pct(r)+'</span>':'<span class="dim">–</span>')+' <span class="dim">'+pc.hits+' hit / '+pc.misses+' miss</span></span>'+
  '<span class="pcc" title="Tokens the server served from its prefix cache (since server start) against the prompt tokens in the router log (since restart)">'+(tot?'<span class="pct"><i class="bar" style="width:'+Math.round(sv*100)+'%;background:var(--acc)"></i></span> ':'')+'<span class="dim">'+fmt(pc.tokensSaved)+' saved'+(tot?' / '+fmt(tot)+' prompt':'')+'</span></span>'+
  (mem?'<span class="pcm dim">'+mem+'</span>':'')+'</div>';
}
function cacheLocalHtml(d,sys0){
 var lh="";
 ((sys0&&sys0.servers)||[]).filter(function(s){return s.up!==false}).forEach(function(s){if(s.prefixCache)lh+=cachePrefixRow(s,(d.promptByProvider||{})[s.provider])});
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
  ctx.html("r",cacheRingHtml(m,(p.sys&&p.sys.servers)||[],p.lim,m.requests<LOW_REQ&&cacheHasNormal(ms)));
 }});
/** chips: cache.note = overall/continuous/one-shot/pool. */
Win.registerType("chips",{minW:160,minH:48,defaultH:60,
 mount:function(ctx){ctx.body.innerHTML='<div class="wm chips" data-k="c"></div>'},
 update:function(ctx,p){
  if(!p||!p.data)return;
  ctx.html("c",cacheNoteHtml(p.data));
 }});
function cacheLocalView(p){
 if(!p||!p.data)return null;
 return{html:cacheLocalHtml(p.data,p.sys)||'<span class="dim">no local server reports a prefix cache</span>'};
}
/** Like the other tables: stacked rows when the table overflows its width; the spec's resize runs it again on a width change. */
function cacheProvidersFit(ctx){fitTables(ctx.body)}
function cacheProvidersView(p){return p&&p.data?{html:cacheProvidersHtml(p.data,p.sys),after:cacheProvidersFit}:null}
function cacheRows(ids){var rows=[],i;for(i=0;i<ids.length;i+=CACHE_RING_ROW)rows.push(ids.slice(i,i+CACHE_RING_ROW));return rows}
/** The rings group's kids: rows of at most CACHE_RING_ROW rings. */
function cacheRingTree(ids){
 var rows=cacheRows(ids).map(function(r){return r.length===1?WinT.leaf(r[0]):WinT.split("r",r.map(WinT.leaf),r.map(function(){return 1/r.length}))});
 return rows.length===1?rows[0]:WinT.split("c",rows,rows.map(function(){return 1/rows.length}));
}
/** A drag in the rings group (its tree order differs from the one applied last) becomes the user's stored order. */
function cacheNoteDrag(){
 var t=Win.state().kids["cache-rings"],cur=cacheTreeIds(t).filter(function(id){return id.indexOf("cache.ring:")===0});
 if(CACHE_APPLIED&&cur.length===CACHE_APPLIED.length&&cur.join("\n")!==CACHE_APPLIED.join("\n"))cacheSetUserOrder(cur);
}
/** Double-click on the group's header drops the stored order: the default order is back. */
function cacheWireReset(){
 var el=Win.el("cache-rings"),h=el&&el.querySelector(".chead");
 if(!h||h.__cacheReset)return;
 h.__cacheReset=1;h.title="double-click: default order";
 h.addEventListener("dblclick",function(){cacheSetUserOrder(null);CACHE_IDS=null;winFeedCache()});
}
/** A structural change: when the set or order of ring cards differs, build the missing ones and swap the group's kids. */
function cacheSync(p){
 if(!p||!p.data||!p.data.byModel)return;
 cacheNoteDrag();
 cacheWireReset();
 var ids=cacheRingIds(p.data),key=ids.join("\n");
 if(key===CACHE_IDS)return;
 var specs=ids.map(function(id){return{id:id,type:"ring",title:id==="cache.none"||id==="cache.solo"?"Cache hit ratio":id.slice(11).split("/").slice(1).join("/"),feeds:["cache"]}});
 Win.addCards("cache-rings",specs,cacheRows(ids));
 // the tree already lays the rings out in this order (the user's drag): keep its rows
 if(cacheTreeIds(Win.state().kids["cache-rings"]).join("\n")!==key)Win.apply("cache-rings",cacheRingTree(ids));
 CACHE_IDS=key;CACHE_APPLIED=ids.filter(function(id){return id.indexOf("cache.ring:")===0});
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
  {id:"cache.note",type:"chips",title:"totals",feeds:["cache"]},
  {id:"cache.local",type:"list",cls:"wm",title:"Local prefix cache",info:CACHE_LOCAL_INFO,feeds:["cache"],view:cacheLocalView},
  {id:"cache.providers",type:"table",title:"Providers",info:CACHE_PROV_INFO,feeds:["cache"],view:cacheProvidersView,resize:cacheProvidersFit}];
 return{tree:WinT.leaf("cache"),kids:{cache:WinT.split("c",[WinT.leaf("cache-rings"),WinT.leaf("cache.note"),WinT.leaf("cache.local"),WinT.leaf("cache.providers")],[0.32,0.12,0.16,0.4]),"cache-rings":WinT.leaf("cache.none")},stDefaults:{},cards:cards};
}
`;
