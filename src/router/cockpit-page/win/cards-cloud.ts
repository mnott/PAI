/** cockpit-page/win — B7 `cloud`: the Limits and local servers section on the win runtime (spec 7/B7).
 *  Page-scope ES5 (after scriptCore + scriptModels: esc/gauge/gbm/shortModel/ringName/ago in scope), needs `Win`,
 *  `WinT`, `WinA` and `winHost()`. Feed `limits` (/cockpit/limits: limits, runningLocal, activeLocal).
 *  Group `limits-local`: one `server` card `limits.local.srv:<provider>` per up local server (a stop header action,
 *  confirm), a loading server is the same card in state "starting", and the `list` card `limits.local.down`
 *  "N local models down" (start button per row) replaces the old <details>. Group `limits-cloud`: one `provider` card
 *  `limits.cloud:<provider>` per cloud provider (its gauges and error line). Start/stop go through WinA.runAction;
 *  the result is the card's header status. Cards are added by data (Win.addCards); one that is gone says so. */

export const WIN_CLOUD_JS = String.raw`var LIML_INFO="Local model servers that are up or loading, and the ones the routing expects that are down.";
var LIMC_INFO="Usage windows per cloud provider: percent used and when each resets.";
var LIM_NONE="limits.cloud.none";
/** The payload row of a provider (local or cloud), null when not in it. */
function limRow(d,p){var ls=(d&&d.limits)||[],i;for(i=0;i<ls.length;i++)if(ls[i].provider===p)return ls[i];return null}
/** Local models the routing expects running that are not up and not loading. */
function limDown(d){
 var run=(d&&d.runningLocal)||[d&&d.activeLocal],out=[];
 ((d&&d.limits)||[]).forEach(function(l){if(l.kind==="local"&&!l.up&&!l.starting&&run.indexOf(l.provider)>=0)out.push(l.provider)});
 return out;
}
/** Resident memory against the model's weight size on disk: text "X GB of Y GB" and, below half resident, the paged-out note. A mapped model's RSS is only the pages currently held. */
function limResident(rssMb,weightsBytes){
 if(rssMb==null)return{txt:"–",note:""};
 if(!weightsBytes)return{txt:gbm(rssMb)+" GB",note:""};
 var y=weightsBytes/1048576;
 return{txt:"resident "+gbm(rssMb)+" GB of "+gbm(y)+" GB",note:rssMb<y/2?"partly paged out — next request slower":""}}
function limServerHtml(l){
 if(l.up){
  var m=l.served&&l.served.length?String(l.served[0]):"";
  function r(k,v,t){return'<span class="dim">'+k+'</span><span class="nw"'+(t?' title="'+esc(t)+'"':"")+'>'+v+'</span>'}
  var res=limResident(l.rssMb,l.weightsBytes);
  var rows=(l.rssMb?r("memory",esc(res.txt))+(res.note?'<span class="dim"></span><span class="dim nw">'+esc(res.note)+"</span>":""):"")+(l.tokensPerSec?r("speed",esc(Math.round(l.tokensPerSec))+" tok/s"):"")+(m?r("model",esc(shortModel(m)),m):"");
  return'<div class="phead"><span class="ok nw">● up</span></div>'+(rows?'<div class="ltab">'+rows+'</div>':"");
 }
 var s=l.starting,failed=s.state==="failed";
 return'<div class="phead"><span class="'+(failed?"bad":"warn")+'" title="'+esc(s.log)+'">'+(failed?esc(s.message):"starting · loading "+s.sinceSec+" s")+'</span></div>';
}
Win.registerType("server",{minW:180,minH:96,defaultH:130,
 mount:function(ctx){ctx.body.innerHTML='<div class="wr" data-k="b"></div>'},
 update:function(ctx,d){
  if(!d||!d.limits)return;
  var l=limRow(d,ctx.id.slice(17));
  if(!l||(!l.up&&!l.starting)){ctx.status("stale","down");ctx.html("b",'<span class="dim">not running</span>');return}
  if(ctx.unstale)ctx.unstale();else ctx.status("","");
  ctx.html("b",limServerHtml(l));
  var al=l.served&&l.served.length&&ringName(String(l.served[0]))!==shortModel(String(l.served[0]))?ringName(String(l.served[0])):"";
  ctx.title(al||l.provider);
 }});
Win.registerType("provider",{minW:200,minH:140,defaultH:160,
 mount:function(ctx){ctx.body.innerHTML='<div class="gauges" data-k="g"></div>'},
 update:function(ctx,d){
  if(!d||!d.limits)return;
  var l=limRow(d,ctx.id.slice(13));
  if(!l){ctx.status("stale","no longer reported");return}
  if(ctx.unstale)ctx.unstale();else ctx.status("","");
  var age=l.error&&/usage reading /.test(l.error)&&l.fetchedAt&&l.fetchedAt<=Date.now()?ago(new Date(l.fetchedAt).toISOString()):"",h="";
  l.windows.forEach(function(w){h+=gauge(l,w,age)});
  if(!l.windows.length)h+='<div class="gauge"><div class="dim">no reading</div><div class="s">'+esc(l.error||"")+'</div></div>';
  else if(l.error)h+='<div class="gauge dim" title="'+esc(l.error)+'"><div class="s">'+esc(l.provider)+': '+esc(l.error)+'</div></div>';
  ctx.html("g",h);
 }});
function limStart(ctx,btn){
 WinA.runAction(ctx.id,"local.start",{target:btn.getAttribute("data-start")},btn,winHost());
}
function limStop(l){
 return{id:"stop",label:"stop",title:"stop this local server",
  run:function(ctx){var b=Win.el(ctx.id).querySelector('[data-act="stop"]');WinA.winClick(b,ctx.id,"local.stop",{target:l},winHost())}};
}
function limNoneView(d){
 if(!d||!d.limits)return null;
 var n=d.limits.filter(function(l){return l.kind!=="local"}).length;
 return{html:'<span class="dim">'+(n?n+" cloud source"+(n===1?"":"s"):"no cloud provider configured")+'</span>'};
}
function limDownView(d){
 if(!d||!d.limits)return null;
 var dn=limDown(d);
 return{title:dn.length+" local model"+(dn.length===1?"":"s")+" down",rows:{items:dn,key:function(n){return n},make:function(){var e=document.createElement("div");e.className="rtsess";return e},fill:function(e,n){
  var h='<span class="chip bad">'+esc(n)+'</span> <button type="button" class="cbtn" data-start="'+esc(n)+'" title="start '+esc(n)+'">start</button>';
  if(e.__h!==h){e.innerHTML=h;e.__h=h}
 }}};
}
function limDownMount(ctx){
 ctx.body.addEventListener("click",function(e){var b=e.target;if(b&&b.getAttribute&&b.getAttribute("data-start"))limStart(ctx,b)});
}
/** Rows of at most 3 cards per band for a dynamic group. */
function limRows(ids){var rows=[],i;for(i=0;i<ids.length;i+=3)rows.push(ids.slice(i,i+3));return rows}
/** The server and provider cards, added by data (a structural change). */
function limitsSync(d){
 if(!d||!d.limits)return;
 var ls=[],cs=[],lr=[],cr=[],i,l;
 for(i=0;i<d.limits.length;i++){
  l=d.limits[i];
  if(l.kind==="local"){
   if(!l.up&&!l.starting)continue;
   ls.push({id:"limits.local.srv:"+l.provider,type:"server",title:l.provider,feeds:["limits"],actions:[limStop(l.provider)]});lr.push("limits.local.srv:"+l.provider);
  }else{cs.push({id:"limits.cloud:"+l.provider,type:"provider",title:l.provider,feeds:["limits"]});cr.push("limits.cloud:"+l.provider)}
 }
 var a=ls.length&&Win.addCards("limits-local",ls,limRows(lr)),b=cs.length&&Win.addCards("limits-cloud",cs,limRows(cr));
 if(a||b)Win.update("limits",d);
 Win.hide("limits.local.down",!limDown(d).length);
 Win.hide(LIM_NONE,cs.length>0);
}
function limLocalDefaults(){
 return{tree:WinT.leaf("limits-local"),stDefaults:{},cards:[{id:"limits-local",type:"group",title:"Local servers",info:LIML_INFO},{id:"limits.local.down",type:"list",title:"0 local models down",feeds:["limits"],hidden:true,view:limDownView,mount:limDownMount}],kids:{"limits-local":WinT.leaf("limits.local.down")}};
}
function limCloudDefaults(){
 return{tree:WinT.leaf("limits-cloud"),stDefaults:{},cards:[{id:"limits-cloud",type:"group",title:"Cloud limits",info:LIMC_INFO},{id:LIM_NONE,type:"list",title:"Cloud sources",feeds:["limits"],hidden:true,view:limNoneView,mount:limDownMount}],kids:{"limits-cloud":WinT.leaf(LIM_NONE)}};
}
`;
