/** cockpit-page — script: limits, routing and the Models section. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** gauge through the model-card job watcher. */
export const scriptModels = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`function gauge(l,w,age){
 var p=Math.max(0,Math.min(100,w.percent)),r=44,cx=60,cy=56,a=Math.PI*p/100;
 var x=cx-r*Math.cos(a),y=cy-r*Math.sin(a);
 var arc='<path d="M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+(cx+r)+' '+cy+'" fill="none" stroke="var(--line)" stroke-width="10" stroke-linecap="round"/>';
 if(p>0)arc+='<path d="M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+x.toFixed(1)+' '+y.toFixed(1)+'" fill="none" stroke="'+sev(p)+'" stroke-width="10" stroke-linecap="round"/>';
 return '<div class="gauge"><svg width="120" height="70" viewBox="0 0 120 70">'+arc+'<text x="60" y="54" text-anchor="middle" style="font-size:16px;font-weight:600;fill:var(--fg)">'+Math.round(w.percent)+'%</text></svg>'+
  '<div class="n">'+esc(l.provider)+' '+esc(w.name)+(age?' <span class="warn" title="'+esc(l.error||"")+'">· '+esc(age)+' old</span>':'')+(w.estimated?' <span class="warn">estimated</span>':'')+'</div>'+
  '<div class="s" data-reset="'+(w.resetAt||0)+'">'+(w.resetAt?'resets in '+dur(w.resetAt-Date.now()):'reset unknown')+'</div></div>';
}
/** The action row shared by the model cards and the cloud gauges. */
function actRow(cls,attrs,btns,msg){
 return'<div class="act '+cls+'"'+attrs+'>'+btns+'<span class="msg">'+esc(msg||"")+'</span></div>';
}
function postAction(action,target,value,cb){
 var body={action:action};if(target!=null)body.target=target;if(value!=null)body.value=value;
 fetch("/cockpit/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),cache:"no-store"})
  .then(function(r){return r.json()}).then(function(j){cb(j)}).catch(function(){cb({ok:false,message:"action failed"})});
}
/** Buttons in an action row: disabled while the action runs; the result text lands on the card.
 * A button click must not reach the card header's fold toggle (the button is inside the header button).
 * A data-confirm button arms on the first click (its own label shows the confirm text) and runs on a
 * second click within CONFIRM_MS; the revert timer restores the label. The row's .msg stays for the
 * action's result. */
var CONFIRM_MS=${n(L.confirmMs)};
var armedKey=null,armedBtn=null,armedTimer=null,actMsg={};
function btnKey(b){return(b.getAttribute("data-a")||"")+"|"+(b.getAttribute("data-t")||"")+"|"+(b.getAttribute("data-v")||"")}
function armBtn(b,cf){armedBtn=b;b.confirmed=true;if(b.__label===undefined)b.__label=b.textContent;b.textContent=cf}
/** The Models section is rebuilt on every changed poll: put the armed confirm and the running/last action message back. */
function reapplyActs(root){
 var bs=root.querySelectorAll("button[data-confirm]");
 for(var i=0;i<bs.length;i++)if(armedKey&&btnKey(bs[i])===armedKey)armBtn(bs[i],bs[i].getAttribute("data-confirm"));
 var as=root.querySelectorAll(".act[data-rt]");
 for(var k=0;k<as.length;k++){
  var am=actMsg[as[k].getAttribute("data-rt")],m=as[k].querySelector(".msg");
  if(m&&am){m.textContent=am.text;m.title=am.text;m.className="msg"+(am.ok?"":" bad")}
  // a running start/stop job keeps its buttons disabled across the poll re-render
  if(am&&am.busy){var bb=as[k].querySelectorAll("button");for(var q=0;q<bb.length;q++)bb[q].disabled=true}
 }
}
function noteMsg(rt,text,ok,busy){if(rt)actMsg[rt]={text:text,ok:ok,busy:!!busy}}
function wireAct(el,onDone){
 var btns=el.querySelectorAll("button");
 for(var i=0;i<btns.length;i++)(function(b){
  b.onclick=function(e){
   if(e&&e.stopPropagation)e.stopPropagation();
   var cf=b.getAttribute("data-confirm");
   if(cf&&!b.confirmed){
    armedKey=btnKey(b);armBtn(b,cf);
    if(armedTimer!=null)clearTimeout(armedTimer);
    // the armed state lives at page level: the poll re-render replaces the element, reapplyActs re-arms the new one
    armedTimer=setTimeout(function(){armedKey=null;armedTimer=null;if(armedBtn){armedBtn.confirmed=false;armedBtn.textContent=armedBtn.__label;armedBtn=null}},CONFIRM_MS);
    return}
   armedKey=null;if(armedTimer!=null){clearTimeout(armedTimer);armedTimer=null}
   b.confirmed=false;
   if(b.__label!==undefined)b.textContent=b.__label;
   var rtName=el.getAttribute("data-rt");
   for(var k=0;k<btns.length;k++){btns[k].disabled=true;if(btns[k].__cfTimer!=null){clearTimeout(btns[k].__cfTimer);btns[k].__cfTimer=null}}
   postAction(b.getAttribute("data-a"),b.getAttribute("data-t")||null,b.getAttribute("data-v")||null,function(j){
    var m=el.querySelector(".msg");if(m){m.textContent=(j&&j.message)||"";m.className="msg"+(j&&j.ok?"":" bad")}
    // an accepted runtime job stays busy (buttons disabled) until the job watcher sees it end
    var busy=!!(rtName&&j&&j.ok&&j.jobId);
    noteMsg(rtName,(j&&j.message)||"",!!(j&&j.ok),busy);
    if(!busy)for(var k=0;k<btns.length;k++)btns[k].disabled=false;
    if(onDone)onDone(j);
   });
  };
 })(btns[i]);
}
/** The Local block is rebuilt by innerHTML on every poll: remember per details kind whether the user opened it and re-apply after the rebuild. */
var downsOpen={};
function keepDowns(el){
 var ds=el.querySelectorAll("details.downs");
 for(var i=0;i<ds.length;i++)(function(d){
  var k=d.getAttribute("data-kind");
  if(downsOpen[k])d.open=true;
  d.ontoggle=function(){downsOpen[k]=d.open};
 })(ds[i]);
}
/** A running local server as a tile like the provider tiles: name (alias if set) and status in the header,
 *  then a two-column table — memory in GB, tokens/s with its unit, the model short name (full id in the title). */
function localTile(l){
 var m=l.served&&l.served.length?String(l.served[0]):"",al=m&&ringName(m)!==shortModel(m)?ringName(m):"";
 function r(k,v,t){return'<span class="dim">'+k+'</span><span class="nw"'+(t?' title="'+esc(t)+'"':"")+'>'+v+'</span>'}
 var rows=(l.rssMb?r("memory",esc(gbm(l.rssMb))+" GB"):"")+(l.tokensPerSec?r("speed",esc(Math.round(l.tokensPerSec))+' tok/s'):"")+(m?r("model",esc(shortModel(m)),m):"");
 return'<div class="pgroup ltile" data-prov="'+esc(l.provider)+'"'+tileAttrs(l.provider,al||l.provider,l.tokensPerSec?Math.round(l.tokensPerSec)+" tok/s":"up")+'>'+tileGrip(al||l.provider)+'<div class="phead"><span class="lname" title="'+esc(l.provider)+'">'+esc(al||l.provider)+'</span><span class="ok nw">● up</span></div>'+(rows?'<div class="ltab">'+rows+'</div>':"")+'</div>';
}
/** A local model whose tier start is in flight: amber "loading <n> s", or red once it timed out / exited. */
function startChip(l){
 var s=l.starting,failed=s.state==="failed";
 return'<span class="chip '+(failed?'bad':'warn')+'" data-prov="'+esc(l.provider)+'" title="'+esc(s.log)+'">'+esc(l.provider)+' · '+(failed?esc(s.message):'loading '+s.sinceSec+' s')+'</span>';
}
function renderLimits(){
 if(!lim)return;var c="",lo="",lt="",dn=[],st=[];
 lim.limits.forEach(function(l){
  var h="",age=l.error&&/usage reading /.test(l.error)&&l.fetchedAt&&l.fetchedAt<=Date.now()?ago(new Date(l.fetchedAt).toISOString()):"";
  if(l.kind==="local"){
   if(!l.up&&l.starting){st.push(l);return}
   if(!l.up){if((lim.runningLocal||[lim.activeLocal]).indexOf(l.provider)>=0)dn.push(l.provider);return}
   lt+=localTile(l);
   return}
  l.windows.forEach(function(w){h+=gauge(l,w,age)});
  if(!l.windows.length)h+='<div class="gauge"><div class="dim">no reading</div><div class="s">'+esc(l.error||"")+'</div></div>';
  else if(l.error)h+='<div class="gauge dim" title="'+esc(l.error)+'"><div class="s">'+esc(l.provider)+': '+esc(l.error)+'</div></div>';
  var w0=l.windows[0];
  c+='<div class="pgroup" data-prov="'+esc(l.provider)+'"'+tileAttrs(l.provider,l.provider,w0?Math.round(w0.percent)+'%':"–")+'>'+tileGrip(l.provider)+'<div class="phead">'+esc(l.provider)+'</div><div class="gauges">'+h+'</div></div>';
 });
 if(st.length)lo+=st.map(startChip).join(" ");
 if(lt)lo='<div class="tgroup" data-tkey="local">'+lt+'</div>'+lo;
 setHtml($("cloud"),c?'<div class="tgroup" data-tkey="cloud">'+c+'</div>':'<span class="dim">no cloud limit sources</span>');
 // the poll rebuild must not reset the order and minimized tiles the user arranged
 orderTiles($("cloud"));
 if(dn.length)lo+='<details class="downs" data-kind="dn"><summary>'+dn.length+' local model'+(dn.length===1?'':'s')+' down</summary>'+dn.map(function(n){return'<span class="chip bad">'+esc(n)+'</span>'}).join(" ")+'</details>';
 setHtml($("local"),lo||'<span class="dim">no local providers</span>');
 keepDowns($("local"));
 orderTiles($("local"));
}
/** Routing section: the flow line of the configured tiers with what each resolves to now (first available entry), then one row per tier (description tooltip, ordered chips coloured by state, the classes it covers, a selector menu) and the sessions overriding it. The menu (local, model:, tag:, class:, providers) puts the pick first in the tier's row through route.set, the workers.yaml writer; the rest stay as fallbacks. */
function renderRouting(){
 var r=lim&&lim.routing;if(!r||!document.querySelector('[data-section="routing"]'))return;
 var rows=r.rows||[];
 var chipsOf=function(cs,rm){return cs.map(function(c,i){return(i?'<span class="rtarrow">→</span>':"")+'<span class="rtchip '+esc(c.state)+'" title="'+esc(c.why||c.state)+'">'+esc(c.label)+(rm?'<button type="button" class="rtrm" data-entry="'+esc(c.entry)+'" title="Remove this entry from the tier" aria-label="remove '+esc(c.label)+'">×</button>':"")+'</span>'}).join("")};
 var flow=rows.length?'<div class="rtflow" id="rtflow">'+esc(r.flow||"")+'</div>':"";
 var menu=function(row){
  var opts=(r.choices||[]).map(function(c){return'<option value="'+esc(c.entry)+'">'+esc(c.label)+'</option>'}).join("");
  return opts?'<select class="rtsel" data-tier="'+esc(row.id)+'" aria-label="selector for '+esc(row.label)+'" title="Serve this tier from a selector: local, model:, tag:, class: or a provider. The pick goes first; the other entries stay as fallbacks."><option value="">selector…</option>'+opts+'</select>':"";
 };
 setHtml($("routing"),rows.length?flow+rows.map(function(row){
  var sessLines=(row.sessions||[]).map(function(s){return'<div class="rtsess" style="margin-left:24px"><span class="rtlabel dim"'+(s.note?' title="'+esc(s.note)+'"':"")+'>'+esc(s.session)+':</span><span class="rtchips">'+chipsOf(s.chips)+'</span></div>'}).join("");
  var tip=[row.description,row.note].filter(Boolean).join(" — ");
  return'<div class="rtrow" data-tier="'+esc(row.id)+'" data-entries="'+esc((row.chips||[]).map(function(c){return c.entry}).join(","))+'"><span class="rtlabel"'+(tip?' title="'+esc(tip)+'"':"")+'>'+esc(row.label)+'</span><span class="rtchips">'+chipsOf(row.chips,true)+'</span>'+menu(row)+'<span class="rtcls dim" style="font-size:11px;margin-left:8px">'+esc((row.classes||[]).join(" · "))+'</span><span class="rtmsg dim"></span>'+sessLines+'</div>'}).join(""):'<span class="dim">no routing table</span>');
 wireRouting($("routing"));
 renderEndpoints(r.endpoints||[]);
}
/** A selector pick posts route.set for its tier; a × removes one entry (route.set with the list minus it; the last entry stays); the limits poll then redraws the row. */
function wireRouting(el){
 if(!el||!el.querySelectorAll)return;
 var rms=el.querySelectorAll("button.rtrm");
 for(var j=0;j<rms.length;j++)(function(btn){
  btn.onclick=function(){
   var row=btn.parentNode.parentNode.parentNode,msg=row.querySelector(".rtmsg");
   var all=(row.getAttribute("data-entries")||"").split(",").filter(Boolean);
   var left=all.filter(function(x){return x!==btn.getAttribute("data-entry")});
   if(!left.length){if(msg){msg.textContent="a tier needs at least one entry";msg.className="rtmsg bad"}return}
   btn.disabled=true;
   postAction("route.set",row.getAttribute("data-tier"),left.join(","),function(j2){
    btn.disabled=false;
    if(msg){msg.textContent=(j2&&j2.message)||"";msg.className="rtmsg"+(j2&&j2.ok?" dim":" bad")}
    if(j2&&j2.ok)loadLimits();
   });
  };
 })(rms[j]);
 var sels=el.querySelectorAll("select.rtsel");
 for(var i=0;i<sels.length;i++)(function(sel){
  sel.onchange=function(){
   var pick=sel.value;if(!pick)return;
   var row=sel.parentNode,msg=row.querySelector(".rtmsg");
   var rest=(row.getAttribute("data-entries")||"").split(",").filter(function(x){return x&&x!==pick});
   sel.disabled=true;
   postAction("route.set",sel.getAttribute("data-tier"),[pick].concat(rest).join(","),function(j){
    sel.disabled=false;sel.value="";
    if(msg){msg.textContent=(j&&j.message)||"";msg.className="rtmsg"+(j&&j.ok?" dim":" bad")}
    if(j&&j.ok)loadLimits();
   });
  };
 })(sels[i]);
}
/** Registered endpoints in the Models section: origin, host, health, routing on/off. PAI never starts or stops them; managed instances have their start/stop in the cards below. */
function renderEndpoints(eps){
 var el=$("endpoints");if(!el)return;
 var h=eps.length?'<div class="eplist">'+eps.map(function(e){
  var cls=e.healthy?"ok":e.enabled?"bad":"dim";
  var toggle=e.origin==="registered"?'<span class="act ep-act" data-ep="'+esc(e.id)+'"><button type="button" class="b" data-a="endpoint.enable" data-t="'+esc(e.id)+'" data-v="'+(e.enabled?"off":"on")+'">'+(e.enabled?"disable routing":"enable routing")+'</button><span class="msg"></span></span>':"";
  return'<div class="eprow" data-ep="'+esc(e.id)+'"><b>'+esc(e.id)+'</b> <span class="dim">'+esc(e.origin)+' · '+esc(e.host)+'</span> <span class="'+cls+'">'+(e.healthy?"healthy":e.enabled?"down":"routing off")+'</span>'+((e.tags||[]).concat((e.classes||[]).map(function(c){return"class:"+c})).length?' <span class="dim">'+esc((e.tags||[]).concat((e.classes||[]).map(function(c){return"class:"+c})).join(" · "))+'</span>':"")+' '+toggle+'</div>'}).join("")+'</div>':"";
 if(setHtml(el,h)){var acts=el.querySelectorAll(".act");for(var i=0;i<acts.length;i++)wireAct(acts[i],function(){loadLimits()})}
}
var mdl=null,mEditing=false,BLUR_CANCEL_MS=400;
/** Short model name: the last path segment of the id ("huggingface.co/…/multilingual-e5-base" → "multilingual-e5-base");
 * the full id rides in the title attribute. */
function shortModel(m){var s=String(m==null?"":m),i=s.lastIndexOf("/");return i>=0?s.slice(i+1):s}
/** A model's display name: the alias the user set on any runtime or consumer, else the short model name. */
function ringName(m){
 var rs=(mdl&&mdl.runtimes)||[];
 for(var i=0;i<rs.length;i++){var ml=rs[i].modelLabels||{};if(ml[m])return ml[m]}
 var cs=(mdl&&mdl.consumers)||[];
 for(i=0;i<cs.length;i++)if(cs[i].model===m&&cs[i].label)return cs[i].label;
 return shortModel(m);
}
/** One catalogue model's own controls, for its own card: start, stop (all its instances), "- n +" instance count —
 * and one line per instance (state, port, pid, rss, in flight, own stop). A stop with requests in flight
 * arms an inline confirm and then sends value=confirm. Returns {btns, inst, live, wanted}: wanted = an instance
 * was started or requested (so a server that does not answer is down, not merely stopped). */
function tierRow(t,instances,starting,rssOf){
 var name=typeof t==="string"?t:t.tier,max=typeof t==="string"?null:t.maxInstances;
 var mine=(instances||[]).filter(function(i){return i.model===name});
 var live=mine.filter(function(i){return i.state!=="failed"}),busy=live.reduce(function(a,i){return a+(i.inflight||0)},0);
 var sc=starting&&starting.tier===name?' <span class="'+(starting.state==="failed"?'bad':'warn')+'" title="'+esc(starting.log)+'">'+(starting.state==="failed"?esc(starting.message):'loading '+starting.sinceSec+' s')+'</span>':"";
 var stopCf=busy?' data-confirm="'+busy+' request'+(busy===1?'':'s')+' in flight - click again to stop" data-v="confirm"':"";
 var btns='<button data-a="local.start" data-t="'+esc(name)+'"'+(max&&live.length>=max?' disabled':'')+'>start</button>'+
  (live.length?'<button data-a="local.stop" data-t="'+esc(name)+'"'+stopCf+'>stop</button>':"")+
  '<button data-a="local.scale" data-t="'+esc(name)+'" data-v="'+Math.max(0,live.length-1)+'"'+(live.length?'':' disabled')+' title="one instance fewer">-</button>'+
  '<span class="num" title="running instances'+(max?' (max '+max+')':'')+'">'+live.length+'</span>'+
  '<button data-a="local.scale" data-t="'+esc(name)+'" data-v="'+(live.length+1)+'"'+(max&&live.length>=max?' disabled':'')+' title="one instance more">+</button>'+sc;
 var inst=mine.map(function(i){
  var rss=rssOf&&rssOf(i.port);
  return'<div class="inst"><span class="'+(i.state==="failed"?'bad':i.state==="ready"?'ok':'warn')+'">'+esc(i.id)+'</span> <span class="dim">'+esc(i.state)+' · :'+i.port+(i.pid!=null?' · pid '+i.pid:'')+(rss?' · '+esc(rss):'')+' · '+(i.inflight||0)+' in flight'+(i.error?' · '+esc(i.error):'')+'</span> '+
   '<button data-a="local.stop" data-t="'+esc(i.id)+'"'+(i.inflight?' data-confirm="'+i.inflight+' in flight - click again to stop" data-v="confirm"':'')+'>stop</button></div>'}).join("");
 return{btns:btns,inst:inst,wanted:mine.length>0||!!sc};
}
/** Models section: one foldable card per consumer runtime — the runtime PAI's embedding runs on, the worker
 * providers' local models (tiers) and the declared consumers (models.consumers) — grouped under their runtime.
 * A runtime whose configured commands can start/stop it carries start/stop buttons on the header (inline
 * confirm, no dialogs); a runtime without configured commands shows no button. A runtime down with consumers
 * reads red "down — <consumer> cannot work"; an idle runner reads "available (loads on first request)".
 * Fold state persists in pai.cockpit.models.folded; default: a running coding runtime open, everything else folded. */
function modelsHtml(inv){
 if(!inv||!inv.runtimes)return"";
 var tiers=inv.tiers||[];
 var running=(inv.running&&inv.running.model)?inv.running:null;
 function rssOf(port){var t=0,hit=false;(inv.runtimes||[]).forEach(function(x){if(x.port===port)(x.models||[]).forEach(function(m){if(m.memoryMb){t+=m.memoryMb;hit=true}})});return hit?(t>=1024?gbm(t)+" GB":t+" MB"):""}
 var cmds=inv.runtimeCommands||{};
 var consumers=inv.consumers||[];
 var tierOfName={};tiers.forEach(function(t){tierOfName[typeof t==="string"?t:t.tier]=t});
 function mem(m){return m==null?"–":m>=1024?gbm(m)+" GB":m+" MB"}
 function n0(v){return v==null?"–":Math.round(v)}
 /* the same rounding as Strata's monitor (serve/web/app.js): decode 1 decimal, prefill integer;
 * every GB on the card goes through gb() — binary GB (1024^3), 1 decimal used / 0 total */
 function f1(v){return v==null?"–":Number(v).toFixed(1)}
 function kfmt(n){return n==null?"–":n>=1000?(n>=10000?Math.round(n/1000)+"k":(n/1000).toFixed(1)+"k"):String(n)}
 function ctxfmt(n){return n&&n%1024===0?Math.round(n/1024)+"K":kfmt(n)}
 /** Strata's Speed tile: decode = the running request, else the last one; prefill = this request, else the last. */
 function speedTile(eng,h){
  var st=eng&&eng.phase;
  var sub=st==="generating"?"Decode now":st==="reading"?"Decode":eng&&eng.lastDecode!=null?"Decode last request":"Decode";
  var psub=st==="reading"?"Prefill now":st==="generating"?"Prefill this request":eng&&eng.lastPromptMs?"Prefill last request":"Prefill";
  return metricTile({title:"Speed",value:f1(eng&&eng.decode),unit:eng&&eng.decode!=null?"t/s":"",sub:(eng&&eng.phase?esc(eng.phase)+" · ":"")+sub,
   secondary:{value:n0(eng&&eng.prefill),unit:eng&&eng.prefill!=null?"t/s":"",sub:psub},
   series:[{data:h.decode||[]},{data:h.prefill||[]}]})
 }
 /** Strata's VRAM measure (the engine's hardware reading) beside the process RSS. */
 function memoryTile(eng,lv,loaded,h){
  var ram=lv&&lv.rssMb!=null?lv.rssMb:(loaded.reduce(function(a,m){return a+(m.memoryMb||0)},0)||null);
  var gpu=eng&&eng.gpuMemUsed!=null,sub="RAM"+(ram!=null?" "+gbm(ram)+" GB":" · not reported")+(gpu?" · GPU "+gb(eng.gpuMemUsed)+(eng.gpuMemTotal!=null?" / "+gb(eng.gpuMemTotal,0)+" GB":""):" · GPU not reported");
  return metricTile({title:"Memory",value:ram!=null?gbm(ram):"–",unit:ram!=null?"GB":"",sub:sub+(loaded[0]&&loaded[0].mappedMb?" · "+gbm(loaded[0].mappedMb)+" GB file mapped":"")+(h.pressurePct&&h.pressurePct.length?" · machine pressure "+n0(h.pressurePct[h.pressurePct.length-1])+"%":""),
   series:[{data:h.memoryMb||[]}]})
 }
 /** Strata's context fill: the running request's tokens, else the last one's, over the engine's max context. */
 function ctxOf(eng){
  if(!eng||eng.maxContext==null)return null;
  var used=eng.liveUsed!=null?eng.liveUsed:eng.lastUsed;
  if(used==null)return null;
  return {pct:Math.min(100,used/eng.maxContext*100),text:Math.round(used/eng.maxContext*100)+"% · "+kfmt(used)+" / "+ctxfmt(eng.maxContext)}
 }
 function liveOf(r){var l=(inv.live&&inv.live.runtimes||[]).filter(function(x){return x.name===r.name})[0];return l?Object.assign({},l.live,{history:l.history}):null}
 /** A consumer's model names the runtime's model: equal, or equal up to ollama's ":latest" tag. */
 function sameModel(a,b){return !!a&&!!b&&(a===b||a.replace(/:latest$/,"")===b.replace(/:latest$/,""))}
 /** The consumers of one model on one runtime: by the model the consumer names;
  * a consumer without a model counts only on a runtime with a single model. */
 function consumersOf(cs2,rt2,m){
  return cs2.filter(function(c){
   if(c.runtime!==rt2.name&&c.runtime!==rt2.kind)return false;
   return c.model?sameModel(c.model,m.model):rt2.models.length===1;
  });
 }
 /** What uses this runtime/model: the inventory's users plus the consumers (PAI's embedding backend, apps). */
 function usersOf(cs2,rt2,m){
  var u=(rt2.users||[]).slice();
  consumersOf(cs2,rt2,m).forEach(function(c){if(u.indexOf(c.name)<0)u.push(c.name)});
  return u;
 }
 /** The consumer sentence: what each user needs the runtime for. */
 function purposeOf(u){
  return u.map(function(n){
   var c=consumers.filter(function(x){return x.name===n})[0];
   if(c){var d=c.purpose||c.label;return d&&d!==n?n+" ("+d+")":n}
   if(n==="pai-embedding")return "PAI's embedding (memory search embeds new content)";
   if(n.indexOf("worker:")===0)return n.slice(7)+" (worker provider)";
   return n;
  }).join(", ");
 }
 /* the display name of a consumer in a confirm: its config label, else the name without the worker: prefix */
 function consumerName(n){
  var c=consumers.filter(function(x){return x.name===n})[0];
  if(c&&c.label)return c.label;
  return String(n).replace(/^worker:/,"");
 }
 /** Header buttons: start/stop from the configured commands only — no command, no button.
  * Only the applicable one shows: running/idle -> stop, stopped -> start; never a disabled twin.
  * A stop on a runtime serving other consumers names them and needs a second click
  * (the same inline confirm as the local model switch); a single-consumer runtime stops in one click. */
 function rtBtns(r,rt2){
  var c=cmds[r.name]||{};
  var dmr=r.kind==="docker-model-runner";
  // docker model runner: idle (nothing loaded) -> load, loaded -> unload; others: stopped -> start, else stop
  // an on-demand runtime (ollama, docker model runner) loads and unloads: the button follows the card's real loaded state
  var ond=dmr||r.kind==="ollama",isLoaded=r.models.some(function(m){return m.loaded});
  if(ond&&r.status!=="stopped"&&!isLoaded)return c.start?'<button data-a="runtime" data-t="'+esc(r.name)+'" data-v="start">load</button>':"";
  if(r.status==="stopped"||(dmr&&r.status==="idle"))return c.start?'<button data-a="runtime" data-t="'+esc(r.name)+'" data-v="start">'+(dmr&&r.status==="idle"?"load":"start")+'</button>':"";
  // the other consumers of this runtime: the card's own consumers (its model's users and
  // the consumers pointing at its model) are not "other"; a runtime-wide user that
  // points at no model (or at a model the runtime does not list) is not a card's own either
  var own={};
  r.models.forEach(function(m){
   (m.usedBy||[]).forEach(function(u){own[u]=1});
   consumersOf(consumers,rt2,m).forEach(function(c){own[c.name]=1});
  });
  var others=usersOf(consumers,rt2,{model:"",kind:"chat",loaded:false,usedBy:[]}).filter(function(u){return !own[u]});
  // a runtime serving only this card's consumers stops in one click: no data-confirm at all
  var cf=others.length?' data-confirm="stop '+esc(r.name)+': also '+esc(others.map(consumerName).join(", "))+' - click again"':"";
  return c.stop?'<button data-a="runtime" data-t="'+esc(r.name)+'" data-v="stop"'+cf+'>'+(ond?"unload":"stop")+'</button>':"";
 }
 var cards="";
 inv.runtimes.forEach(function(rt){
  // one card per consumer model: a runtime hosting several consumer-labelled models
  // (ollama: qwen3:8b for chat, arctic-embed for embeddings) splits into one card per
  // model; a runtime without several labelled models keeps one card for all its models
  var rts=[];
  var keyed=rt.models.filter(function(m){return m.label||(m.usedBy||[]).length||consumers.some(function(c){return(c.runtime===rt.name||c.runtime===rt.kind)&&sameModel(c.model,m.model)})});
  // a consumer's model the runtime does not list (yet) still gets its card
  consumers.forEach(function(c){if((c.runtime===rt.name||c.runtime===rt.kind)&&c.model&&!rt.models.some(function(m){return sameModel(c.model,m.model)}))keyed.push({model:c.model,kind:"embedding",loaded:false,usedBy:[c.name]})});
  if(keyed.length>1||(keyed.length&&consumers.some(function(c){return c.name==="pai-embedding"&&(c.runtime===rt.name||c.runtime===rt.kind)})))keyed.forEach(function(m){rts.push(Object.assign({},rt,{models:[m],split:true}))});
  // a runtime with no models of its own still shows its declared consumers (a stopped ollama)
  else if(!rt.models.length&&consumers.some(function(c){return c.runtime===rt.name||c.runtime===rt.kind}))rts.push(Object.assign({},rt,{models:[{model:"",kind:"chat",loaded:false,usedBy:[]}]}));
  else rts.push(rt);
  rts.forEach(function(r){
  var lv=liveOf(r),eng=lv&&lv.engine,h=lv&&lv.history||{},w=(lv&&lv.workers||[]);
  var loaded=r.models.filter(function(m){return m.loaded});
  var hasModel=!!(r.models.length&&r.models[0].model);
  var users=usersOf(consumers,rt,r.models[0]||{model:"",kind:"chat",loaded:false,usedBy:[]});
  // a card is per consumer: on a runtime shared by several, the runtime-wide users stay out of it
  if(r.split&&hasModel){users=(r.models[0].usedBy||[]).slice();consumersOf(consumers,rt,r.models[0]).forEach(function(c){if(users.indexOf(c.name)<0)users.push(c.name)})}
  // a runtime with no models of its own: every consumer pointing at it still waits on it
  if(!hasModel)consumers.forEach(function(c){if((c.runtime===rt.name||c.runtime===rt.kind)&&users.indexOf(c.name)<0)users.push(c.name)});
  // a catalogue model with no instance anybody started is stopped (grey), not down (red)
  var tr=r.tier&&tierOfName[r.tier]?tierRow(tierOfName[r.tier],inv.instances,inv.starting&&inv.starting.tier===r.tier?inv.starting:null,rssOf):null;
  var stopped=r.status==="stopped"&&!!tr&&!tr.wanted;
  var down=r.status==="stopped"&&!stopped;
  var coding=loaded.some(function(m){return m.kind==="coding"})||r.models.some(function(m){return m.kind==="coding"});
  // a running on-demand runtime (ollama, docker model runner) whose model is not in memory loads it on the first request
  var idle=!down&&(r.status==="idle"||(hasModel&&!loaded.length&&(r.kind==="ollama"||r.kind==="docker-model-runner")));
  var state=stopped?"stopped":down?"down":idle?"available (loads on first request)":"running";
  // the tile order is keyed by the card's position in the grid, not its model id:
  // a renamed alias must not scramble the tiles the user arranged
  var tkey=r.name+" / "+(hasModel?r.models[0].model:"")+" tiles";
  var key=stopped?r.name+(r.port==null?"":" :"+r.port):down?(users.length?users.length+" consumer"+(users.length===1?"":"s")+" waiting":r.name+(r.port==null?"":" :"+r.port))
   :idle?(hasModel?r.models.length+" installed":"no model")
   :loaded.length?mem(loaded.reduce(function(a,m){return a+(m.memoryMb||0)},0)):r.models.length+" models";
  /* purpose first: the title is the consumer's label (config only), the model id is grey secondary text;
   * without a label the consumer name, then the model id */
  function titleOf(m){
   // the inventory's per-model label first (models.consumers[].label / models.labels),
   // then the payload's consumer label, then the runtime label — all from config
   var lbl=m.label||"";
   if(!lbl){var cc=consumers.filter(function(x){return sameModel(x.model,m.model)&&(x.runtime===rt.name||x.runtime===rt.kind)})[0];if(cc&&cc.label)lbl=cc.label}
   if(!lbl)lbl=(r.modelLabels&&r.modelLabels[m.model])||r.label||"";
   if(lbl)return lbl;
   var cs=consumersOf(consumers,rt,m);
   if(cs.length)return cs[0].name;
   var u=(m.usedBy||[]).length?m.usedBy:(rt.models.length===1?users:[]);
   var first=u.length?String(u[0]):"";
   return first?first.replace(/^worker:/,""):shortModel(m.model);
  }
  // two rows: the title on its own row beside the status dot (full name, wraps), the chips on the row below
  var head='<div class="mhead" role="button" tabindex="0" aria-expanded="false"><div class="mtitle"><span class="chev">▸</span><span class="rt-dot'+(stopped?" off":down?" down":r.slow?" slow":idle?" idle":"")+'"></span>'+
   '<b'+(hasModel?' title="'+esc(r.models[0].model)+'"':"")+'>'+esc(hasModel?titleOf(r.models[0]):r.name)+'</b>'+
   (hasModel?'<button class="lblbtn" data-alias="'+esc(r.models[0].label||"")+'" title="set an alias for this model" aria-label="edit alias">✎</button>':"")+
   '</div><div class="mchips">'+
   (hasModel?'<span class="mid" title="'+esc(r.models[0].model)+'">'+esc(shortModel(r.models[0].model))+'</span>':"")+
   (r.kind===r.name||r.kind===r.name+(r.port==null?"":" :"+r.port)?"":'<span class="badge">'+esc(r.kind)+'</span>')+
   // the runtime chip carries the runtime's note (models.runtimes.<name>.note) as its title,
   // never a body line: a shared runtime's note belongs to the runtime, not to one consumer's card
   '<span class="badge"'+(cmds[r.name]&&cmds[r.name].note?' title="'+esc(cmds[r.name].note)+'"':"")+'>'+esc(r.name)+(r.port==null?"":" :"+r.port)+'</span>'+
   '<span class="badge'+(down?' bad':r.slow?' warn':'')+'"'+(r.slow?' title="the last probe was slow or failed; the last good reading is held"':'')+'>'+(r.slow&&!down?"slow":state)+'</span>'+
   (tr?'<span class="act rt-act" data-rt="'+esc(r.name)+'">'+tr.btns+'<span class="msg"></span></span>':rtBtns(r,rt)?'<span class="act rt-act" data-rt="'+esc(r.name)+'">'+rtBtns(r,rt)+'<span class="msg"></span></span>':"")+
   '<span class="num">'+esc(key)+'</span></div></div>';
  var body="";
  if(stopped){
   body+='<div class="mdim">'+esc(r.name)+(r.port==null?"":" :"+r.port)+" stopped</div>";
  }else if(down){
   body+='<div class="mdown">'+esc(r.name)+(r.port==null?"":" :"+r.port)+" down — "+(users.length?esc(purposeOf(users))+" cannot work":"no consumer")+'</div>';
  }else if(!loaded.length){
   var size=r.models.reduce(function(a,m){return a+(m.sizeMb||0)},0)||null;
   body+='<div class="rt-tiles two" data-tkey="'+esc(tkey)+'">'+
    metricTile({title:"Memory / size",value:mem(size),unit:"",sub:hasModel?r.models.length+" model"+(r.models.length===1?"":"s")+" installed, none loaded":"no model installed",series:[]})+
    metricTile({title:"Users",value:users.length,unit:"",sub:users.length?esc(purposeOf(users)):"no declared consumer",series:[]})+
    '</div>';
  }else{
   var ctx=ctxOf(eng);
   body+='<div class="rt-tiles" data-tkey="'+esc(tkey)+'">'+
    speedTile(eng,h)+
    memoryTile(eng,lv,loaded,h)+
    metricTile({title:"Workers",value:w.filter(function(x){return x.state==="running"}).length,unit:"",sub:(lv&&lv.cap!=null?"cap "+lv.cap:"cap –")+" · queued "+((lv&&lv.queued)||0)+(lv&&lv.conversationSlots!=null?" · slots "+lv.conversationSlots:"")+" · spares "+(lv&&lv.sparesReady?lv.sparesReady:0),
     series:[{data:h.queued||[]}]})+
    metricTile({title:"Conversation cache",value:eng&&eng.parked!=null?eng.parked:"–",unit:eng&&eng.parked!=null?"/ "+(eng.slots!=null?eng.slots:"–"):"",
     sub:eng&&eng.reusedPct!=null?"reused "+pct(eng.reusedPct/100)+" of prompt tokens":"this engine does not report prompt reuse",
     fill:ctx?{pct:ctx.pct,text:ctx.text}:null,
     series:[{data:h.reusedPct||[]}]})+'</div>';
   var chips=w.map(function(x){return'<span class="chip" title="'+esc(x.id)+'">'+esc(x.label||x.id)+(x.session&&x.session!=="?"?' <b>'+esc(x.session)+'</b>':"")+(x.state==="queued"?' <span class="warn">queued</span>':x.state==="running"?' <span class="dim">running</span>':"")+'</span>'}).join("");
   if(chips)body+='<div class="rt-chips">'+chips+'</div>';
  }
  // the purpose line is the card's own consumer's description (config), never the runtime's or another consumer's
  var own=consumers.filter(function(c){return users.indexOf(c.name)>=0&&(c.runtime===rt.name||c.runtime===rt.kind)});
  var sub="";
  if(own.length)sub=(own.filter(function(c){return c.purpose||c.label})[0]||{}).purpose||(own.filter(function(c){return c.label})[0]||{}).label||"";
  else if(r.split&&hasModel)sub=r.models[0].label||"";
  else if(!consumers.some(function(c){return c.runtime===rt.name||c.runtime===rt.kind}))sub=r.label||"";
  if(users.indexOf(sub)>=0)sub="";
  if(stopped)body+='<div class="mdim">will use any running local model</div>';
  else if(users.length)body+='<div class="rt-sub"'+(users.length?' title="'+esc(users.join(", "))+'"':"")+'>'+esc(sub)+(sub?" · ":"")+"used by "+esc(purposeOf(users))+'</div>';
  if(tr&&tr.inst)body+='<div class="linst">'+tr.inst+'</div>';
  cards+='<div class="mcard'+(down?" down":stopped?" stopped":"")+'" data-tid="'+esc(r.name+(hasModel?" / "+r.models[0].model:""))+'" data-rt="'+esc(r.name)+'" data-model="'+esc(hasModel?r.models[0].model:"")+'" data-def="'+(r.status==="running"&&coding?${q(L.foldDefaultKind)}:"other")+'" data-tname="'+esc(hasModel?titleOf(r.models[0]):r.name)+'" data-tval="'+esc(r.status)+'"><span class="tgrip" data-tgrip tabindex="0" title="move card" aria-label="move card" aria-pressed="false" role="button">⠿</span>'+head+'<div class="mbody">'+body+'</div></div>';
  });
 });
 var h='<div class="rt-grid" data-tkey="models cards">'+(cards||'<span class="dim">no consumer runtime</span>')+'</div>';
 // a duplicates hint only for the same model id on two runtimes (the inventory already filters that)
 (inv.duplicates||[]).forEach(function(d){h+='<div class="warn">duplicates: '+esc(d)+'</div>'});
 return h;
}
/** Fold state of the model cards: pai.cockpit.models.folded lists the folded card ids
 * (runtime + first model id, so two cards on one runtime fold separately).
 * Default: a runtime running a coding model opens, everything else folds.
 * The whole header line is the toggle: it is a <button>, so Enter/Space fire a click too. */
var MCOLLAPSE_KEY="pai.cockpit.models.folded";
// the saved array is the folded list; __init marks "the defaults were applied once",
// so a card absent from the list after that is open, not unknown
function mFolded(){var s={};try{var r=localStorage.getItem(MCOLLAPSE_KEY);if(r){JSON.parse(r).forEach(function(k){s[k]=1});s.__init=1}}catch(e){}return s}
function saveMFolded(s){try{var a=[];for(var k in s)if(s[k]&&k!=="__init")a.push(k);localStorage.setItem(MCOLLAPSE_KEY,JSON.stringify(a))}catch(e){}}
function applyModelFold(){
 var el=$("modelspanel"),saved=mFolded(),init=saved.__init,known={};
 var cards=el.querySelectorAll(".mcard");
 for(var i=0;i<cards.length;i++)(function(c){
  var rt=c.getAttribute("data-rt")||"",md=c.getAttribute("data-model")||"";
  var id=rt+(md?" / "+md:"");known[id]=1;
  var open=c.classList.contains("open");
  // the stored array is the folded list: an id in it is folded, an id not in it is open
  // (a re-rendered card has lost its class, so after init the absence of the id is the only truth)
  if(id in saved)open=!saved[id];
  else if(init===1)open=true;
  else{
   var d=c.getAttribute("data-def");
   open=d===${q(L.foldDefaultKind)};
   // only the folded cards are stored; an open card is the absence of its id
   if(!open)saved[id]=1;
  }
  c.classList.toggle("open",open);
  var b=c.querySelector(".mhead");
  if(b){b.setAttribute("aria-expanded",open?"true":"false");var ch=b.querySelector(".chev");if(ch)ch.textContent=open?"▾":"▸"}
  if(!b.onclick){b.onkeydown=function(e){if(e.target===b&&(e.key==="Enter"||e.key===" ")){e.preventDefault();b.onclick()}};}
  if(!b.onclick)b.onclick=function(){
   var nowOpen=!c.classList.contains("open");
   c.classList.toggle("open",nowOpen);
   var folded=JSON.parse(localStorage.getItem(MCOLLAPSE_KEY)||"[]");
   folded=nowOpen?folded.filter(function(k){return k!==id}):folded.concat([id]);
   try{localStorage.setItem(MCOLLAPSE_KEY,JSON.stringify(folded))}catch(e){}
   b.setAttribute("aria-expanded",nowOpen?"true":"false");
   var ch=b.querySelector(".chev");if(ch)ch.textContent=nowOpen?"▾":"▸";
  };
 })(cards[i]);
 // a card that left the inventory: its saved state goes with it
 // (not while no card is rendered: the "…" placeholder is not an empty inventory)
 if(cards.length)for(var k in saved)if(k!=="__init"&&!(k in known))delete saved[k];
 saved.__init=1;saveMFolded(saved);
}
/** The panel header control: minimizes every model card through the tile minimize state (tkey+"#min"), or restores them all when all are minimized. */
function wireMinAll(el){
 var b=$("minall"),g=el.querySelector('[data-tkey="models cards"]');if(!b)return;
 var ids=g?tids(g):[],mins=g?(tileOrder()[tkeyOf(g)+"#min"]||[]):[],all=ids.length>0&&ids.every(function(x){return mins.indexOf(x)>=0});
 b.hidden=!ids.length;b.textContent=all?"+":"–";b.title=all?"restore all model cards":"minimize all model cards";
 b.setAttribute("aria-label",b.title);b.setAttribute("aria-pressed",all?"true":"false");
 b.onclick=function(){
  var g2=el.querySelector('[data-tkey="models cards"]');if(!g2)return;
  var s2=tileOrder(),k2=tkeyOf(g2)+"#min",i2=tids(g2);
  if(i2.every(function(x){return(s2[k2]||[]).indexOf(x)>=0}))delete s2[k2];else s2[k2]=i2;
  saveTileOrder(s2);applyTileOrder(g2);wireMinAll(el);
 };
}
function renderModels(){
 var el=$("modelspanel");if(!el)return;
 // a pending poll never replaces a rendering that already shows data
 if(!mdl&&el.__html)return;
 if(mdl&&mEditing)return;
 var changed=setHtml(el,mdl?modelsHtml(mdl):'<span class="dim" title="loading: first models poll pending">…</span>');
 applyModelFold();
 // the poll rebuild must not reset the tile order the user arranged
 orderTiles(el);
 wireMinAll(el);
 // the global switch lives in the panel header: one off for every local model
 var lo=$("localoff");
 if(lo){var haveTiers=!!(mdl&&(mdl.tiers||[]).length);lo.hidden=!haveTiers;if(haveTiers&&!lo.firstChild){setHtml(lo,'<button data-a="local.off" data-confirm="stop every local model - click again" title="stop every local model">off</button><span class="msg"></span>');wireAct(lo,function(){loadModels()})}}
 setTip($("modelstip"),mdl&&mdl.at?"Models by what uses them: one foldable card per consumer runtime (the router samples each running runtime every 5 s; a value the runtime does not report shows –). Start/stop run the configured commands only (config models.runtimes.<name>). Inventory at "+mdl.at.slice(0,16).replace("T"," "):"Models");
 // a runtime job the server reports as running (started before a page reload): busy card, watched unless already
 var rj=(mdl&&mdl.runtimeJobs)||{};
 for(var rjn in rj){
  var rjb=rj[rjn];if(!rjb||!rjb.id)continue;
  if(!actMsg[rjn]||!actMsg[rjn].busy)noteMsg(rjn,(rjb.op==="stop"?"stopping…":"starting…")+(rjb.elapsedSec!=null?" "+rjb.elapsedSec+" s":"")+(rjb.tail?" · "+rjb.tail:""),true,true);
  if(!(watchJob.live&&watchJob.live[rjb.id]))watchJob(rjb.id);
 }
 if(!changed)return;
 var acts=el.querySelectorAll(".act");
 for(var i=0;i<acts.length;i++)wireAct(acts[i],function(j){if(j&&j.jobId)watchJob(j.jobId);else loadModels()});
 reapplyActs(el);
 var lbls=el.querySelectorAll(".lblbtn");
 for(var k=0;k<lbls.length;k++)(function(btn){
  var head=btn.parentNode,card=head.parentNode,t=head.querySelector("b");
  var rt=card.getAttribute("data-rt"),md=card.getAttribute("data-model");
  btn.onkeydown=function(e){e.stopPropagation()};
  btn.onclick=function(e){
   e.stopPropagation();
   if(head.querySelector("input.lblin"))return;
   var alias=btn.getAttribute("data-alias")||"";
   var inp=document.createElement("input");inp.type="text";inp.className="lblin";inp.setAttribute("data-lblin",rt+"/"+md);
   inp.value=alias;inp.placeholder="alias";
   var done=false,timer=null,ui=[];
   function mk(txt,cls,title,fn){
    var b=document.createElement("button");b.type="button";b.className="lblact "+cls;b.textContent=txt;b.title=title;b.setAttribute("aria-label",title);
    b.onclick=function(ev){ev.stopPropagation();fn()};b.onkeydown=function(ev){ev.stopPropagation()};
    head.appendChild(b);ui.push(b);return b;
   }
   function close(){
    done=true;mEditing=false;if(timer){clearTimeout(timer);timer=null}
    ui.forEach(function(n){if(head.contains(n))head.removeChild(n)});ui=[];
    if(head.contains(inp))head.replaceChild(t,inp);
    renderModels();
   }
   function save(val){
    if(done)return;done=true;if(timer){clearTimeout(timer);timer=null}
    postAction("model.label",rt,"model:"+md+"="+val,function(j2){
     if(j2&&j2.ok){close();loadModels()}
     else{done=false;msg.textContent=(j2&&j2.message)||"save failed"}
    });
   }
   inp.onclick=function(ev){ev.stopPropagation()};
   inp.onfocus=function(){if(timer){clearTimeout(timer);timer=null}};
   inp.onkeydown=function(ev){ev.stopPropagation();if(ev.key==="Enter"){ev.preventDefault();save(inp.value.trim())}else if(ev.key==="Escape"){close()}};
   // blur alone never saves: unless a button is tapped (or focus returns) within a moment, cancel
   inp.onblur=function(){if(done)return;if(timer)clearTimeout(timer);timer=setTimeout(function(){timer=null;if(!done)close()},BLUR_CANCEL_MS)};
   head.replaceChild(inp,t);
   mk("✓","lblok","save alias",function(){save(inp.value.trim())});
   mk("✕","lblno","cancel",close);
   if(alias)mk("↺","lblrs","reset to the original name",function(){save("")});
   var msg=document.createElement("span");msg.className="lblmsg dim";head.appendChild(msg);ui.push(msg);
   mEditing=true;inp.focus({preventScroll:true});
  };
 })(lbls[k]);
}
/** A local switch/off job: poll its state; the card refreshes from the inventory. Jobs being watched are kept in watchJob.live. */
function watchJob(id){
 var live=watchJob.live||(watchJob.live={});
 if(live[id])return;
 live[id]=1;
 var tries=0;
 function step(){
  fetch("/cockpit/job?id="+encodeURIComponent(id),{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){
   var el=$("modelspanel");
   var ended=j&&(j.state==="done"||j.state==="failed");
   if(j&&j.kind==="runtime"&&j.runtime){
    // the card header shows starting…/stopping… with the elapsed seconds and the log's last line, then the job's result
    var txt=ended?(j.message||""):(j.op==="stop"?"stopping…":"starting…")+(j.elapsedSec!=null?" "+j.elapsedSec+" s":"")+(j.tail?" · "+j.tail:"");
    noteMsg(j.runtime,txt,j.state!=="failed",!ended);
    reapplyActs(el);
   }else{
    var msgs=el.querySelectorAll(".act .msg");
    for(var i=0;i<msgs.length;i++)msgs[i].textContent=(j&&j.message)||"";
   }
   if(ended){delete live[id];loadModels();return}
   if(++tries<JOB_TRIES)setTimeout(step,JOB_POLL);else delete live[id];
  }).catch(function(){if(++tries<JOB_TRIES)setTimeout(step,JOB_POLL);else delete live[id]});
 }
 setTimeout(step,JOB_FIRST);
}
`;
