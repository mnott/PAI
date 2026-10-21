/** cockpit-page/win — B4 `pool`: the "Worker pool" group on the win runtime (spec 7/B4).
 *  Page-scope ES5 (after scriptCore: esc/fmt/pct/table in scope), needs `Win` and `WinT`. Feed `pool`
 *  (/cockpit/pool, PoolPanelData). Group `pool`: six `kv` cards pool|host|tasks|hit|spares|not-pooled
 *  over the `table` card `pool.slots`; with the pool off and its host down the group holds the single
 *  `note` card `pool.off` instead (the group's kids are swapped on the first feed and when the state flips; the arrangement of the full group is kept). */

export const WIN_POOL_JS = String.raw`var POOL_KV=["pool","host","tasks","hit","spares","not-pooled"];
var POOL_TITLES={"pool":"pool","host":"host","tasks":"tasks served · since host start","hit":"first-request hit · lifetime","spares":"spares · now","not-pooled":"not pooled · 24 h"};
var POOL_INFO="Whether the worker session pool is on, whether its host is up, what every slot has carried, and how many runs of the last 24 h did not go through it.";
var poolFull=null,poolIsOff=null;
function poolDur(s){return s<90?s+"s":s<5400?Math.round(s/60)+"m":Math.round(s/3600)+"h"}
/** The pool is off and its host is not running: one note, not a dashboard of zeros. */
function poolOff(p){return!!p&&!p.enabled&&!p.hostUp}
/** One kv card of the pool header: {v: html, s: html, t: plain title}. */
function poolKv(key,p){
 var sp=p.spares||[],sm=p.spareMisses||[],l=p.last24h,r;
 if(key==="pool")r={v:p.enabled?'<span class="ok">enabled</span>':'<span class="bad">disabled</span>',s:"max "+p.maxSlots+" slots · idle kill "+(p.idleKillSecs?poolDur(p.idleKillSecs):"never")};
 else if(key==="host")r={v:p.hostUp?'<span class="ok">up</span>':'<span class="bad">down</span>',s:"port "+p.port+(p.hostSince?" · since "+esc(p.hostSince):"")+(p.hostBuiltAt?" · built "+esc(p.hostBuiltAt):"")+(p.hostStale?' · <span class="warn">stale (newer build on disk)</span>':"")};
 else if(key==="tasks")r={v:String(p.totals.tasksServed),s:fmt(p.totals.tokensCarried)+" cache-read tokens carried (lifetime)"};
 else if(key==="hit")r={v:p.totals.hitRatio==null?"n/a":pct(p.totals.hitRatio),s:p.totals.carriedTasks+" pooled task(s) in the metrics file"+(p.slots.length?" · "+p.slots.map(function(s){return esc(s.provider)+" "+(s.hitRatio==null?"n/a":pct(s.hitRatio))}).join(", "):"")};
 else if(key==="spares")r={v:sp.reduce(function(n,s){return n+s.ready},0)+" ready",s:(sp.length?sp.map(function(s){return esc(s.provider)+" "+s.ready+" ready"+(s.starting?" +"+s.starting+" starting":"")}).join(", ")+" · ":"none · ")+(p.spareClaims||0)+" claimed since host start"+(sm.length?" · missed "+sm.map(function(m){return esc(m.reason)+" x"+m.misses}).join(", "):"")};
 else r={v:l.notPooled+" of "+l.runs,s:l.pooled+" pooled"+(l.topReason?" · top reasons: "+(l.reasons||[]).slice(0,4).map(function(x){return esc(x.reason)+" "+x.runs}).join(", "):(l.notPooled&&!l.poolOff?" · reasons not logged yet":""))+(l.poolOff?" · "+l.poolOff+" while pool off":"")};
 r.t=r.s.replace(/<[^>]*>/g,"");
 return r;
}
/** The slots table (html string for the table card's slot). */
function poolSlotsHtml(p){
 if(!p.slots.length)return'<span class="dim" title="A slot spawns with the first pooled task.">no slots</span>';
 return table(["provider .txt","model .txt","cwd .txt","state .txt","task .txt","branch .txt","first","age","idle","tasks","carried","hit%"],p.slots.map(function(s){return[esc(s.provider),esc(s.model),'<span title="'+esc(s.cwd)+'">'+esc(s.cwd.split("/").slice(-2).join("/"))+'</span>','<span class="'+(s.state==="busy"?"warn":"ok")+'">'+s.state+'</span>',s.task?esc(s.task):"-",s.branch?esc(s.branch):"-",s.firstRequest?'<span class="'+(s.firstRequest==="warm"?"ok":"warn")+'">'+s.firstRequest+'</span>':"-",poolDur(s.ageSecs),poolDur(s.idleSecs),s.tasks,fmt(s.tokensCarried),s.hitRatio==null?"-":pct(s.hitRatio)]}));
}
function poolOffText(p){return"Pool off · host not running"+(p.hostLastSeen?" · last seen "+p.hostLastSeen:"")+(p.hostBuiltAt?" · last built "+p.hostBuiltAt:"")+(p.offReason?" · why: "+p.offReason:"")+" — every worker starts cold (no pre-started spare). Turn on with pai worker pool on."}
Win.registerType("kv",{minW:150,minH:68,defaultH:90,
 mount:function(ctx){ctx.body.innerHTML='<div class="wm"><b class="wm-v" data-k="v"></b><span class="wm-s" data-k="s"></span></div>'},
 update:function(ctx,p){
  if(ctx.id.indexOf("memory.")===0){memKvUpdate(ctx,p);return}
  if(!p||poolOff(p))return;
  var m=poolKv(ctx.id.slice(5),p);
  ctx.html("v",m.v);ctx.html("s",m.s);ctx.attr("s","title",m.t);
 }});
Win.registerType("table",{minW:300,minH:80,defaultH:160,
 mount:function(ctx){ctx.body.innerHTML='<div class="tw" data-k="t"></div>'},
 update:function(ctx,p){if(p&&!poolOff(p))ctx.html("t",poolSlotsHtml(p))}});
Win.registerType("note",{minW:150,minH:48,defaultH:60,
 mount:function(ctx){ctx.body.innerHTML='<div class="wm"><span class="wm-s" data-k="n"></span></div>'},
 update:function(ctx,p){if(p&&poolOff(p))ctx.text("n",poolOffText(p))}});
/** A copy of a kids tree without the leaf id; weights renormalize, a one-child split collapses. */
function poolWithout(n,id){
 if(n.k==="c")return n.id===id?null:n;
 var ch=[],sz=[],t=0,i,c;
 for(i=0;i<n.ch.length;i++){c=poolWithout(n.ch[i],id);if(c){ch.push(c);sz.push(n.sz[i]);t+=n.sz[i]}}
 if(!ch.length)return null;
 if(ch.length===1)return ch[0];
 return WinT.split(n.d,ch,sz.map(function(x){return x/t}));
}
/** Swap the group's kids between the full set and the single note when the off state flips. */
function poolSwap(p){
 if(!p)return;
 var off=poolOff(p),kids=Win.state().kids.pool;
 if(off===poolIsOff)return;
 if(off){poolFull=poolWithout(kids,"pool.off");poolIsOff=true;Win.apply("pool",WinT.leaf("pool.off"))}
 else{Win.apply("pool",poolIsOff&&poolFull?poolFull:poolWithout(kids,"pool.off"));poolIsOff=false}
}
function poolDefaults(){
 var cards=[{id:"pool",type:"group",title:"Worker pool",info:POOL_INFO}],ch=[],i;
 for(i=0;i<POOL_KV.length;i++){
  cards.push({id:"pool."+POOL_KV[i],type:"kv",title:POOL_TITLES[POOL_KV[i]],feeds:["pool"]});
  ch.push(WinT.leaf("pool."+POOL_KV[i]));
 }
 cards.push({id:"pool.slots",type:"table",title:"slots",feeds:["pool"]});
 cards.push({id:"pool.off",type:"note",title:"Pool off",feeds:["pool"]});
 var row=WinT.split("r",ch,ch.map(function(){return 1/ch.length}));
 return{tree:WinT.leaf("pool"),kids:{pool:WinT.split("c",[row,WinT.leaf("pool.slots"),WinT.leaf("pool.off")],[0.3,0.6,0.1])},stDefaults:{},cards:cards};
}
`;
