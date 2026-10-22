/** cockpit-page/win — B8 `models`: the Models section on the win runtime (spec 7/B8).
 *  Page-scope ES5 (after scriptCore + scriptModels: esc/gbm/gb/pct/shortModel/BLUR_CANCEL_MS in scope), needs `Win`, `WinT`,
 *  `WinA` ({runAction, winClick}) and `winHost()`. Feeds `models` (/cockpit/models) and `limits` (routing.endpoints).
 *  Group `models`: header action `local.off` (confirm), the `eplist` card `models.endpoints` (origin/host/health + enable
 *  toggle through winClick), then one `runtime` card `models.rt:<runtime>/<model>` per runtime(+model), added by data. A runtime
 *  card carries start/stop/load/unload/scale/alias as header actions (disabled with their reason, never a dead control), a
 *  speed / memory / workers / conversation-cache grid (2 cells when nothing is loaded), worker chips, the purpose line and the
 *  instance list. The old minimize-all button is gone: minimize is on each card. Names are prefixed wmd* (no page-scope clash). */

export const WIN_MODELS_JS = String.raw`var WMD_INFO="Models by what uses them: one card per consumer runtime (and per labelled model). The router samples each running runtime every 5 s.";
var WMD=null,WMD_SEEN={};
function wmdMem(m){return m==null?"–":m>=1024?gbm(m)+" GB":m+" MB"}
function wmdF1(v){return v==null?"–":Number(v).toFixed(1)}
function wmdSame(a,b){return!!a&&!!b&&(a===b||a.replace(/:latest$/,"")===b.replace(/:latest$/,""))}
function wmdOn(c,rt){return c.runtime===rt.name||c.runtime===rt.kind}
/** The runtime split into the cards it shows: one per labelled/consumer model, else the runtime whole. */
function wmdSplit(rt,consumers){
 var keyed=rt.models.filter(function(m){return m.label||(m.usedBy||[]).length||consumers.some(function(c){return wmdOn(c,rt)&&wmdSame(c.model,m.model)})});
 consumers.forEach(function(c){if(wmdOn(c,rt)&&c.model&&!rt.models.some(function(m){return wmdSame(c.model,m.model)}))keyed.push({model:c.model,kind:"embedding",loaded:false,usedBy:[c.name]})});
 if(keyed.length>1||(keyed.length&&consumers.some(function(c){return c.name==="pai-embedding"&&wmdOn(c,rt)})))return keyed.map(function(m){return Object.assign({},rt,{models:[m],split:true})});
 if(!rt.models.length&&consumers.some(function(c){return wmdOn(c,rt)}))return[Object.assign({},rt,{models:[{model:"",kind:"chat",loaded:false,usedBy:[]}]})];
 return[rt];
}
/** The users of one card: its model's users plus the consumers pointing at it. */
function wmdUsers(r,rt,consumers){
 var m=r.models[0]||{model:"",usedBy:[]},u=r.split&&m.model?(m.usedBy||[]).slice():(rt.users||[]).slice();
 consumers.forEach(function(c){
  if(!wmdOn(c,rt)||u.indexOf(c.name)>=0)return;
  if(!m.model||(c.model?wmdSame(c.model,m.model):rt.models.length===1))u.push(c.name);
 });
 return u;
}
function wmdPurpose(u,consumers){
 return u.map(function(n){
  var c=consumers.filter(function(x){return x.name===n})[0];
  if(c){var d=c.purpose||c.label;return d&&d!==n?n+" ("+d+")":n}
  if(n==="pai-embedding")return"PAI's embedding (memory search embeds new content)";
  return n.indexOf("worker:")===0?n.slice(7)+" (worker provider)":n;
 }).join(", ");
}
/** The catalogue tier of a card: its instances (not failed = live), the busy count, the max. */
function wmdTier(inv,r){
 var t=null,i,tiers=inv.tiers||[];
 for(i=0;i<tiers.length;i++)if((typeof tiers[i]==="string"?tiers[i]:tiers[i].tier)===r.tier)t=tiers[i];
 if(!t)return null;
 var name=typeof t==="string"?t:t.tier,mine=(inv.instances||[]).filter(function(x){return x.model===name});
 var live=mine.filter(function(x){return x.state!=="failed"});
 return{name:name,max:typeof t==="string"?null:t.maxInstances,mine:mine,live:live,busy:live.reduce(function(a,x){return a+(x.inflight||0)},0),
  starting:inv.starting&&inv.starting.tier===name?inv.starting:null};
}
function wmdTitle(r,rt,consumers,users){
 var m=r.models[0]||{},lbl=m.label||"";
 if(!lbl){var cc=consumers.filter(function(x){return wmdSame(x.model,m.model)&&wmdOn(x,rt)})[0];if(cc&&cc.label)lbl=cc.label}
 if(!lbl)lbl=(r.modelLabels&&r.modelLabels[m.model])||r.label||"";
 if(lbl)return lbl;
 if(!m.model)return r.name;
 return users.length?String(users[0]).replace(/^worker:/,""):shortModel(m.model);
}
/** A registry model has its own card (models.model:<name>); the runtime card of the same tier would show it twice. */
function wmdCovered(inv,r){return!!r.tier&&(inv.registryModels||[]).some(function(m){return m.tier===r.tier})}
/** The registry model by card id (models.model:<name>). */
function wmdModel(id){
 var list=(WMD&&WMD.inv&&WMD.inv.registryModels)||[],i;
 for(i=0;i<list.length;i++)if("models.model:"+list[i].name===id)return list[i];
 return null;
}
/** The card list of an inventory: [{id,title,r,rt,m,users,tier,state,stopped,down,idle,loaded,cmds,consumers}]. */
function wmdCards(inv){
 var out=[],consumers=inv.consumers||[],cmds=inv.runtimeCommands||{};
 (inv.runtimes||[]).forEach(function(rt){
  wmdSplit(rt,consumers).forEach(function(r){
   if(wmdCovered(inv,r))return;
   var m=r.models[0]||{model:""},users=wmdUsers(r,rt,consumers),tier=r.tier?wmdTier(inv,r):null;
   var loaded=r.models.filter(function(x){return x.loaded});
   var stopped=r.status==="stopped"&&!!tier&&!(tier.mine.length||tier.starting),down=r.status==="stopped"&&!stopped;
   var idle=!down&&(r.status==="idle"||(!!m.model&&!loaded.length&&(r.kind==="ollama"||r.kind==="docker-model-runner")));
   out.push({id:"models.rt:"+r.name+"/"+(m.model||""),title:wmdTitle(r,rt,consumers,users),r:r,rt:rt,m:m,users:users,tier:tier,loaded:loaded,
    stopped:stopped,down:down,idle:idle,state:stopped?"stopped":down?"down":idle?"available (loads on first request)":"running",cmds:cmds[r.name]||{},consumers:consumers});
  });
 });
 return out;
}
function wmdLive(inv,r){var l=(inv.live&&inv.live.runtimes||[]).filter(function(x){return x.name===r.name})[0];return l?Object.assign({},l.live,{history:l.history}):null}
function wmdEntry(id){if(!WMD)return null;if(WMD.byId===undefined||WMD.at!==WMD.inv){WMD.byId={};wmdCards(WMD.inv).forEach(function(e){WMD.byId[e.id]=e});WMD.at=WMD.inv}return WMD.byId[id]||null}
/** One cell of the metric grid. */
function wmdCell(t,v,u,s){return'<div class="wmdc"><div class="wmdt">'+esc(t)+'</div><div><b class="wmdv">'+esc(v)+'</b><small class="wm-u">'+esc(u||"")+'</small></div><div class="dim wmds">'+s+'</div></div>'}
/** "of Y GB on disk" + the paged-out note for a runtime whose tier's model size is known; "" otherwise. */
function wmdRes(inv,r,ram){
 var m=(inv.registryModels||[]).filter(function(x){return x.tier===r.tier})[0];
 if(!m||!m.weightsBytes||ram==null)return"";
 var y=m.weightsBytes/1048576;
 return"of "+gbm(y)+" GB · "+(ram<y/2?"partly paged out — next request slower · ":"");
}
function wmdCells(e,inv){
 var r=e.r,lv=wmdLive(inv,r),eng=lv&&lv.engine,w=(lv&&lv.workers)||[];
 if(e.stopped||e.down)return"";
 if(!e.loaded.length){
  var size=r.models.reduce(function(a,m){return a+(m.sizeMb||0)},0)||null;
  return wmdCell("Memory / size",wmdMem(size),"",e.m.model?r.models.length+" installed, none loaded":"no model installed")+
   wmdCell("Users",String(e.users.length),"",e.users.length?esc(wmdPurpose(e.users,e.consumers)):"no declared consumer");
 }
 var ram=lv&&lv.rssMb!=null?lv.rssMb:(e.loaded.reduce(function(a,m){return a+(m.memoryMb||0)},0)||null);
 return wmdCell("Speed",wmdF1(eng&&eng.decode),eng&&eng.decode!=null?"t/s":"",(eng&&eng.phase?esc(eng.phase)+" · ":"")+"decode"+(eng&&eng.prefill!=null?" · prefill "+Math.round(eng.prefill)+" t/s":""))+
  wmdCell("Memory",ram!=null?gbm(ram):"–",ram!=null?"GB":"",wmdRes(inv,r,ram)+"RAM"+(eng&&eng.gpuMemUsed!=null?" · GPU "+gb(eng.gpuMemUsed):" · GPU not reported"))+
  wmdCell("Workers",String(w.filter(function(x){return x.state==="running"}).length),"",(lv&&lv.cap!=null?"cap "+lv.cap:"cap –")+" · queued "+((lv&&lv.queued)||0)+" · spares "+((lv&&lv.sparesReady)||0))+
  wmdCell("Conversation cache",eng&&eng.parked!=null?String(eng.parked):"–",eng&&eng.parked!=null?"/ "+(eng.slots!=null?eng.slots:"–"):"",eng&&eng.reusedPct!=null?"reused "+pct(eng.reusedPct/100)+" of prompt tokens":"no prompt reuse reported");
}
function wmdKf(n){return n==null?"–":n>=1000?(n>=10000?Math.round(n/1000)+"k":(n/1000).toFixed(1)+"k"):String(n)}
/** Context fill: the running request's tokens, else the last one's, over the engine's max context; "" when not reported. */
function wmdCtx(e,inv){
 var lv=wmdLive(inv,e.r),eng=lv&&lv.engine;
 if(e.stopped||e.down||!e.loaded.length||!eng||eng.maxContext==null)return"";
 var used=eng.liveUsed!=null?eng.liveUsed:eng.lastUsed;
 if(used==null)return"";
 var p=Math.min(100,used/eng.maxContext*100),mx=eng.maxContext%1024===0?Math.round(eng.maxContext/1024)+"K":wmdKf(eng.maxContext);
 return'<div class="wmd-cf" title="context fill: tokens of the running (else last) request over the max context" style="height:6px;border-radius:3px;background:var(--line);overflow:hidden"><i style="display:block;height:100%;width:'+p.toFixed(1)+'%;background:var(--acc)"></i></div><small class="dim">context '+Math.round(p)+'% · '+wmdKf(used)+' / '+mx+'</small>';
}
function wmdChips(e,inv){
 var lv=wmdLive(inv,e.r),w=(lv&&lv.workers)||[];
 return w.map(function(x){return'<span class="chip" title="'+esc(x.id)+'">'+esc(x.label||x.id)+(x.session&&x.session!=="?"?" <b>"+esc(x.session)+"</b>":"")+(x.state==="queued"?' <span class="warn">queued</span>':x.state==="running"?' <span class="dim">running</span>':"")+"</span>"}).join("");
}
function wmdNote(e){
 var r=e.r,own=e.consumers.filter(function(c){return e.users.indexOf(c.name)>=0&&wmdOn(c,e.rt)}),sub="";
 if(e.stopped)return"will use any running local model";
 if(own.length)sub=(own.filter(function(c){return c.purpose||c.label})[0]||{}).purpose||(own.filter(function(c){return c.label})[0]||{}).label||"";
 else if(r.split&&e.m.model)sub=e.m.label||"";
 else if(!e.consumers.some(function(c){return wmdOn(c,e.rt)}))sub=r.label||"";
 if(e.users.indexOf(sub)>=0)sub="";
 if(e.down)return esc(r.name)+(r.port==null?"":" :"+r.port)+" down — "+(e.users.length?esc(wmdPurpose(e.users,e.consumers))+" cannot work":"no consumer");
 return e.users.length?esc(sub)+(sub?" · ":"")+"used by "+esc(wmdPurpose(e.users,e.consumers)):esc(sub);
}
function wmdInst(i){
 var h='<span class="'+(i.state==="failed"?"bad":i.state==="ready"?"ok":"warn")+'">'+esc(i.id)+'</span> <span class="dim">'+esc(i.state)+" · :"+i.port+(i.pid!=null?" · pid "+i.pid:"")+" · "+(i.inflight||0)+" in flight"+(i.error?" · "+esc(i.error):"")+'</span> <button type="button" class="b wmd-stop" data-act="local.stop" data-id="'+esc(i.id)+'" data-busy="'+(i.inflight||0)+'" title="stop instance '+esc(i.id)+' (asks to confirm when requests are in flight)">stop</button>';
 return h;
}
/** The header actions of a runtime card: [id, label, title, enabled(e) -> true | reason, run(e, el)]. */
function wmdActs(id){
 function ent(){return wmdEntry(id)}
 function runIt(act,verb,args){var b=Win.el(id).querySelector('[data-act="'+act+'"]');WinA.winClick(b,id,verb,args,winHost())}
 return[
  {id:"start",label:"start",enabled:function(){var e=ent();if(!e)return"no data yet";
    if(e.tier)return e.tier.max&&e.tier.live.length>=e.tier.max?"at the maximum ("+e.tier.max+")":true;
    var ond=e.r.kind==="ollama"||e.r.kind==="docker-model-runner";
    if(e.down||e.r.status==="stopped"||(ond&&!e.loaded.length))return e.cmds.start?true:"no start command configured";return"already running"},
   run:function(){var e=ent();if(e.tier)runIt("start","local.start",{target:e.tier.name});else runIt("start","runtime",{target:e.r.name,value:"start"})}},
  {id:"stop",label:"stop",enabled:function(){var e=ent();if(!e)return"no data yet";
    if(e.tier)return e.tier.live.length?true:"nothing running";
    if(e.down||e.r.status==="stopped")return"not running";
    if((e.r.kind==="ollama"||e.r.kind==="docker-model-runner")&&!e.loaded.length)return"nothing loaded";
    return e.cmds.stop?true:"no stop command configured"},
   run:function(){var e=ent();if(e.tier)runIt("stop","local.stop",{target:e.tier.name,value:e.tier.busy?"confirm":undefined});else runIt("stop","runtime",{target:e.r.name,value:"stop"})}},
  {id:"less",label:"-",title:"one instance fewer",enabled:function(){var e=ent();return e&&e.tier&&e.tier.live.length?true:"no running instance"},
   run:function(){var e=ent();runIt("less","local.scale",{target:e.tier.name,count:Math.max(0,e.tier.live.length-1)})}},
  {id:"more",label:"+",title:"one instance more",enabled:function(){var e=ent();if(!e||!e.tier)return"no instance control for this runtime";return e.tier.max&&e.tier.live.length>=e.tier.max?"at the maximum ("+e.tier.max+")":true},
   run:function(){var e=ent();runIt("more","local.scale",{target:e.tier.name,count:e.tier.live.length+1})}},
  {id:"alias",label:"✎",title:"set an alias for this model",enabled:function(){var e=ent();return e&&e.m.model?true:"no model on this card"},
   run:function(){wmdEdit(id)}}
 ];
}
/** The label-edit control: an input in the card body; Enter saves, Escape or a blur (after BLUR_CANCEL_MS) cancels. */
function wmdEdit(id){
 var e=wmdEntry(id),c=Win.ctx(id),slot=Win.el(id).querySelector('[data-k="edit"]');
 if(!e||!slot||slot.firstChild)return;
 var inp=document.createElement("input"),done=false,timer=null;
 inp.type="text";inp.className="wmd-in";inp.value=e.m.label||"";inp.placeholder="alias";inp.setAttribute("aria-label","alias for "+e.m.model);
 function close(){if(done)return;done=true;if(timer)clearTimeout(timer);if(inp.parentNode)inp.parentNode.removeChild(inp)}
 function save(){
  var val=inp.value.trim();close();
  WinA.runAction(id,"model.label",{target:e.r.name,value:"model:"+e.m.model+"="+val},null,winHost()).then(function(r){if(r.ok&&typeof loadModels==="function")loadModels()});
 }
 inp.addEventListener("keydown",function(ev){ev.stopPropagation();if(ev.key==="Enter"){ev.preventDefault();save()}else if(ev.key==="Escape")close()});
 inp.addEventListener("blur",function(){timer=setTimeout(close,BLUR_CANCEL_MS)});
 slot.appendChild(inp);inp.focus({preventScroll:true});
}
Win.registerType("runtime",{minW:300,minH:150,defaultH:220,
 mount:function(ctx){
  ctx.body.innerHTML='<div class="wmd"><div class="wmd-top"><span data-k="badges"></span><span data-k="edit"></span></div><div class="wmd-g" data-k="cells"></div><div data-k="ctx"></div><div class="rt-chips" data-k="chips"></div><div class="dim wmd-n" data-k="note"></div><div class="wmd-i" data-k="inst"></div></div>';
  ctx.body.addEventListener("click",function(ev){
   var b=ev.target;
   if(!b||!b.classList||!b.classList.contains("wmd-stop"))return;
   WinA.winClick(b,ctx.id,"local.stop",{target:b.getAttribute("data-id"),value:b.getAttribute("data-busy")!=="0"?"confirm":undefined},winHost());
  });
 },
 update:function(ctx,inv){
  var e=wmdEntry(ctx.id);
  if(!e){ctx.status("stale","no longer reported");return}
  var r=e.r;
  ctx.html("badges",(e.m.model?'<span class="mid" title="'+esc(e.m.model)+'">'+esc(shortModel(e.m.model))+"</span> ":"")+
   (r.kind===r.name?"":'<span class="badge">'+esc(r.kind)+"</span> ")+'<span class="badge"'+(e.cmds.note?' title="'+esc(e.cmds.note)+'"':"")+">"+esc(r.name)+(r.port==null?"":" :"+r.port)+'</span> <span class="badge mstate'+(e.down?" bad":r.slow?" warn":"")+'">'+esc(r.slow&&!e.down?"slow":e.state)+"</span>"+
   (e.tier?' <span class="num" title="running instances'+(e.tier.max?" (max "+e.tier.max+")":"")+'">'+e.tier.live.length+(e.tier.max?" / "+e.tier.max:"")+"</span>":"")+
   (e.tier&&e.tier.starting?' <span class="'+(e.tier.starting.state==="failed"?"bad":"warn")+'">'+(e.tier.starting.state==="failed"?esc(e.tier.starting.message):"loading "+e.tier.starting.sinceSec+" s")+"</span>":""));
  ctx.html("cells",wmdCells(e,inv));
  ctx.html("ctx",wmdCtx(e,inv));
  ctx.html("chips",e.stopped||e.down?"":wmdChips(e,inv));
  ctx.html("note",wmdNote(e));
  ctx.list("inst",e.tier?e.tier.mine:[],function(i){return i.id},function(){var d=document.createElement("div");d.className="linst";return d},function(d,i){var h=wmdInst(i);if(d.__h!==h){d.innerHTML=h;d.__h=h}});
 }});
/** The header actions of a registry-model card: start, stop (confirm when requests are in flight), instance stepper -/+ (local.scale). */
function wmdModelActs(id){
 function runIt(act,verb,args){var b=Win.el(id).querySelector('[data-act="'+act+'"]');WinA.winClick(b,id,verb,args,winHost())}
 function busy(m){return m.instances.reduce(function(a,x){return a+(x.inflight||0)},0)}
 return[
  {id:"start",label:"start",enabled:function(){var m=wmdModel(id);if(!m)return"no data yet";return m.maxInstances&&m.instances.length>=m.maxInstances?"at the maximum ("+m.maxInstances+")":true},
   run:function(){var m=wmdModel(id);runIt("start","local.start",{target:m.tier})}},
  {id:"stop",label:"stop",enabled:function(){var m=wmdModel(id);if(!m)return"no data yet";return m.instances.length?true:"nothing running"},
   run:function(){var m=wmdModel(id);runIt("stop","local.stop",{target:m.tier,value:busy(m)?"confirm":undefined})}},
  {id:"less",label:"-",title:"one instance fewer",enabled:function(){var m=wmdModel(id);return m&&m.instances.length?true:"no running instance"},
   run:function(){var m=wmdModel(id);runIt("less","local.scale",{target:m.tier,count:Math.max(0,m.instances.length-1)})}},
  {id:"more",label:"+",title:"one instance more",enabled:function(){var m=wmdModel(id);if(!m)return"no data yet";return m.maxInstances&&m.instances.length>=m.maxInstances?"at the maximum ("+m.maxInstances+")":true},
   run:function(){var m=wmdModel(id);runIt("more","local.scale",{target:m.tier,count:m.instances.length+1})}}
 ];
}
Win.registerType("model",{minW:300,minH:90,defaultH:120,
 mount:function(ctx){
  ctx.body.innerHTML='<div class="wmd"><div class="wmd-top" data-k="badges"></div><div class="dim wmd-n" data-k="note"></div><div class="wmd-i" data-k="inst"></div></div>';
  ctx.body.addEventListener("click",function(ev){
   var b=ev.target;
   if(!b||!b.classList||!b.classList.contains("wmd-stop"))return;
   WinA.winClick(b,ctx.id,"local.stop",{target:b.getAttribute("data-id"),value:b.getAttribute("data-busy")!=="0"?"confirm":undefined},winHost());
  });
 },
 update:function(ctx){
  var m=wmdModel(ctx.id);
  if(!m){ctx.status("stale","no longer reported");return}
  var n=m.instances.length;
  ctx.html("badges",'<span class="badge">'+esc(m.engine)+'</span> <span class="badge mstate">'+esc(m.state)+'</span> '+(WMD&&WMD.inv&&WMD.inv.localDefaultTier===m.tier?'<span class="badge ok" title="the running model local work goes to (pai worker run --local)">local default</span> ':"")+'<span class="num" title="running instances (max '+m.maxInstances+')">'+n+" / "+m.maxInstances+"</span>");
  ctx.html("note",(m.weightsBytes?'<span class="num" title="weight size on disk">'+gbm(m.weightsBytes/1048576)+" GB</span> · ":"")+'<span title="'+esc(m.file)+'">'+esc(String(m.file).replace(/^.*\//,""))+"</span> · :"+m.port);
  ctx.list("inst",m.instances,function(i){return i.id},function(){var d=document.createElement("div");d.className="linst";return d},function(d,i){
   var h='<span class="ok">'+esc(i.id)+'</span> <span class="dim">:'+i.port+(i.pid!=null?" · pid "+i.pid:"")+" · "+(i.inflight||0)+' in flight</span> <button type="button" class="b wmd-stop" data-act="local.stop" data-id="'+esc(i.id)+'" data-busy="'+(i.inflight||0)+'" title="stop instance '+esc(i.id)+' (asks to confirm when requests are in flight)">stop</button>';
   if(d.__h!==h){d.innerHTML=h;d.__h=h}
  });
 }});
Win.registerType("eplist",{minW:260,minH:44,defaultH:90,
 mount:function(ctx){
  ctx.body.innerHTML='<div class="wmd-e" style="padding:6px 10px"><div data-k="rows"></div><div class="dim" data-k="none"></div></div>';
  ctx.body.addEventListener("click",function(ev){
   var b=ev.target;
   if(b&&b.classList&&b.classList.contains("wmd-en"))WinA.winClick(b,ctx.id,"endpoint.enable",{target:b.getAttribute("data-t"),value:b.getAttribute("data-v")},winHost());
  });
 },
 update:function(ctx,d){
  var eps=d&&d.routing&&d.routing.endpoints;
  if(!eps)return;
  ctx.text("none",eps.length?"":"no endpoints registered");
  ctx.list("rows",eps,function(e){return e.id},function(){var x=document.createElement("div");x.className="eprow";return x},function(x,e){
   var cls=e.healthy?"ok":e.enabled?"bad":"dim",tags=(e.tags||[]).concat((e.classes||[]).map(function(c){return"class:"+c})).join(" · ");
   var h='<b>'+esc(e.id)+'</b> <span class="dim">'+esc(e.origin)+" · "+esc(e.host)+'</span> <span class="'+cls+'">'+(e.healthy?"healthy":e.enabled?"down":"routing off")+"</span>"+(tags?' <span class="dim">'+esc(tags)+"</span>":"")+
    (e.origin==="registered"?' <button type="button" class="b wmd-en" data-t="'+esc(e.id)+'" data-v="'+(e.enabled?"off":"on")+'">'+(e.enabled?"disable routing":"enable routing")+"</button>":"");
   if(x.__h!==h){x.innerHTML=h;x.__h=h}
  });
 }});
/** The runtime cards, added by data (a structural change); a card already in the layout is only built. */
function wmdSync(inv){
 var list=wmdCards(inv),specs=[],rows=[],i,reg=inv.registryModels||[];
 for(i=0;i<reg.length;i++){
  var mid="models.model:"+reg[i].name;
  if(WMD_SEEN[mid])continue;
  WMD_SEEN[mid]=1;
  specs.push({id:mid,type:"model",title:reg[i].name,feeds:["models"],actions:wmdModelActs(mid)});
  rows.push([mid]);
 }
 for(i=0;i<list.length;i++){
  if(WMD_SEEN[list[i].id])continue;
  WMD_SEEN[list[i].id]=1;
  specs.push({id:list[i].id,type:"runtime",title:list[i].title,feeds:["models"],actions:wmdActs(list[i].id)});
  rows.push([list[i].id]);
 }
 if(specs.length&&Win.addCards("models",specs,rows))Win.update("models",inv);
}
/** The models feed: remember the payload for the actions' enabled(), push it, then add cards for new runtimes. */
function winFeedModels(inv){
 if(!inv||!inv.runtimes)return;
 WMD={inv:inv};
 Win.update("models",inv);
 wmdSync(inv);
}
function wmdOff(){WinA.winClick(Win.el("models").querySelector('[data-act="off"]'),"models","local.off",{},winHost())}
function modelsDefaults(){
 var cards=[{id:"models",type:"group",title:"Models",info:WMD_INFO,feeds:["models"],actions:[{id:"off",label:"stop all local",title:"stop every local model server (asks to confirm)",run:wmdOff}]},
  {id:"models.endpoints",type:"eplist",title:"Endpoints",feeds:["limits"]}];
 return{tree:WinT.leaf("models"),kids:{models:WinT.leaf("models.endpoints")},stDefaults:{},cards:cards};
}
`;
