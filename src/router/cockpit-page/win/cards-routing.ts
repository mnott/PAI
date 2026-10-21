/** cockpit-page/win — B6 `routing`: the Routing section on the win runtime (spec 7/B6).
 *  Page-scope ES5 (after scriptCore: esc in scope), needs `Win`, `WinT`, `WinA` ({Select, runAction}) and
 *  `winHost()`. Feed `limits` (/cockpit/limits, payload.routing = {rows, flow, choices}). Group `routing`:
 *  the `rtflow` card `routing.flow` (the flow line), then one `routing-row` card `routing.<tier>` per tier,
 *  added by data through Win.addCards. A row card: title = tier label, info = description/note, the chips with
 *  their × buttons, the styled Select (A9) fed from `choices`, the classes, the sessions overriding the tier as
 *  a list. route.set goes through runAction; its result is the row card's header status (no .rtmsg). */

export const WIN_ROUTING_JS = String.raw`var RT_INFO="Per delegation tier (workers.yaml tiers) the models in the order they serve: the first available one, then the fallback order. A local model that is not running is skipped, not started. Pick a selector per tier; it is written to workers.yaml like pai worker route set.";
var RT_NONE="a tier needs at least one entry";
function rtChips(cs,rm){return cs.map(function(c,i){return(i?'<span class="rtarrow">→</span>':"")+'<span class="rtchip '+esc(c.state)+'" title="'+esc(c.why||c.state)+'">'+esc(c.label)+(rm?'<button type="button" class="rtrm" data-entry="'+esc(c.entry)+'" title="Remove this entry from the tier" aria-label="remove '+esc(c.label)+'">×</button>':"")+'</span>'}).join("")}
function rtTip(row){return[row.description,row.note].filter(Boolean).join(" — ")}
function rtRowOf(d,tier){var rs=(d&&d.routing&&d.routing.rows)||[],i;for(i=0;i<rs.length;i++)if(rs[i].id===tier)return rs[i];return null}
/** route.set for one tier with the given entry list; the result lands in the row card's status. */
function rtSet(ctx,tier,models,el){
 return WinA.runAction(ctx.id,"route.set",{target:tier,models:models},el,winHost()).then(function(r){if(r.ok&&typeof loadLimits==="function")loadLimits();return r});
}
/** The × of a chip: the tier's entries minus that one; the last entry stays (refused in the status). */
function rtRemove(ctx,btn){
 var st=ctx.body.__rt;if(!st)return;
 var left=st.entries.filter(function(x){return x!==btn.getAttribute("data-entry")});
 if(!left.length){ctx.status("err",RT_NONE);return}
 rtSet(ctx,st.tier,left,btn);
}
/** A selector pick goes first; the other entries stay as fallbacks. */
function rtPick(ctx,pick){
 var st=ctx.body.__rt;if(!st||!pick)return;
 var rest=st.entries.filter(function(x){return x!==pick});
 rtSet(ctx,st.tier,[pick].concat(rest),st.sel);
 st.sel.setValue(null);
}
Win.registerType("rtflow",{minW:200,minH:40,defaultH:44,
 mount:function(ctx){ctx.body.innerHTML='<div class="wm"><span class="rtflow" data-k="n"></span></div>'},
 update:function(ctx,d){var r=d&&d.routing;if(r)ctx.text("n",(r.rows||[]).length?r.flow||"":"no routing table")}});
Win.registerType("routing-row",{minW:260,minH:70,defaultH:96,
 mount:function(ctx){
  ctx.body.innerHTML='<div class="wr"><div class="wr-top"><span class="rtchips" data-k="chips"></span><span class="wr-sel" data-k="sel"></span><span class="rtcls dim" data-k="cls"></span></div><div class="wr-sess" data-k="sess"></div></div>';
  var st={tier:ctx.id.slice(8),entries:[],opts:"",sel:null};
  st.sel=WinA.Select({options:[],value:null,placeholder:"selector…",ariaLabel:"selector for "+st.tier,onChange:function(v){rtPick(ctx,v)}});
  st.sel.title="Serve this tier from a selector: local, model:, tag:, class: or a provider. The pick goes first; the other entries stay as fallbacks.";
  ctx.body.querySelector('[data-k="sel"]').appendChild(st.sel);
  ctx.body.__rt=st;
  ctx.body.addEventListener("click",function(e){var b=e.target;if(b&&b.classList&&b.classList.contains("rtrm"))rtRemove(ctx,b)});
 },
 update:function(ctx,d){
  var st=ctx.body.__rt,row=rtRowOf(d,ctx.id.slice(8));
  if(!st||!d||!d.routing)return;
  if(!row){st.gone=true;ctx.status("stale","no longer configured");return}
  if(st.gone){st.gone=false;ctx.status("","")}
  st.entries=(row.chips||[]).map(function(c){return c.entry});
  ctx.html("chips",rtChips(row.chips||[],true));
  ctx.text("cls",(row.classes||[]).join(" · "));
  var o=JSON.stringify(d.routing.choices||[]);
  if(o!==st.opts){st.opts=o;st.sel.setOptions((d.routing.choices||[]).map(function(c){return{value:c.entry,label:c.label}}))}
  ctx.list("sess",row.sessions||[],function(s){return s.session},function(){var e=document.createElement("div");e.className="rtsess";return e},function(e,s){
   var h='<span class="rtlabel dim"'+(s.note?' title="'+esc(s.note)+'"':"")+'>'+esc(s.session)+':</span><span class="rtchips">'+rtChips(s.chips||[])+'</span>';
   if(e.__h!==h){e.innerHTML=h;e.__h=h}
  });
 }});
/** The tier cards, added by data (a structural change); a tier already in the layout is only built. */
function routingSync(d){
 var rs=(d&&d.routing&&d.routing.rows)||[],specs=[],rows=[],i;
 for(i=0;i<rs.length;i++){
  specs.push({id:"routing."+rs[i].id,type:"routing-row",title:rs[i].label,info:rtTip(rs[i])||undefined,feeds:["limits"]});
  rows.push(["routing."+rs[i].id]);
 }
 if(specs.length&&Win.addCards("routing",specs,rows))Win.update("limits",d);
}
/** The limits feed: the static flow card, then the tier cards. */
function winFeedLimits(j){Win.update("limits",j);routingSync(j)}
function routingDefaults(){
 return{tree:WinT.leaf("routing"),stDefaults:{},cards:[{id:"routing",type:"group",title:"Routing",info:RT_INFO},{id:"routing.flow",type:"rtflow",title:"flow",feeds:["limits"]}],kids:{routing:WinT.leaf("routing.flow")}};
}
`;
