/** cockpit-page/win — `speed`, `pause`, `sessions`, `runs`: four cards on the general types, no type of their own.
 *  Page-scope ES5 (after script-tables: speedHtml, pauseHtml, sessionsHtml, workersHtml, fitTables in scope), needs `Win`.
 *  `speed` is a `chart` card (hook WCHX.speed: the bars), `pause` and `sessions` are `table` cards, `runs` a `list` card;
 *  each spec's view(payload, ctx) returns the html its page builder makes plus after: fitTables (stacked rows when the table
 *  overflows; the spec's resize runs it again on a width change). The runs fold (data-wrfold, WR_FOLD_KEY) and the sessions
 *  "+N more" row (data-sessmore, SESS_MORE_KEY) are row-level disclosures wired by the spec's mount; they redraw by
 *  re-feeding the page's data. */

export const WIN_TABLES_JS = String.raw`var WT_INFO={speed:"TTFT = request sent to first content token. Read = input tokens / TTFT (prefill incl. cached for local models; for Anthropic input excludes cache reads). Write = output tokens / decode time, replies of 16+ tokens only. Medians (p50) unless marked.",
 pause:"Per model. Pause = time since the previous request of the same session. A drop in hits after 5m means the cache expired between turns: a keepalive under 5m would have kept it."};
/** speed: the bars are the page's speedHtml, which reads the data/sys/lim globals, so every feed repaints them. */
WCHX.speed={
 mount:function(ctx){ctx.body.innerHTML='<div class="wt-svg wt-auto" data-k="svg"></div>'},
 update:function(ctx){if(typeof data!=="undefined"&&data&&data.speed)ctx.html("svg",speedHtml())},
 resize:function(){}
};
function wtFit(ctx){fitTables(ctx.body)}
/** Row-level disclosures: a click on a fold or "+N more" row stores its state and re-feeds the page's data; a click on a session row opens its detail panel (SESS_OPEN), a tab or close button changes it. */
function wtWire(ctx){
 ctx.body.addEventListener("click",function(e){
  var t=e.target&&e.target.closest?e.target.closest("[data-wrfold],[data-sessmore],[data-sess],[data-hit],[data-sesstab],[data-sessclose]"):null;
  if(!t||!ctx.body.contains(t))return;
  e.preventDefault();
  var redraw=function(){Win.update("data",data)};
  if(t.hasAttribute("data-hit"))return sessDetailOpen(t.getAttribute("data-hit"),redraw,Number(t.getAttribute("data-turn")));
  if(t.hasAttribute("data-sess"))return sessDetailOpen(t.getAttribute("data-sess"),redraw);
  if(t.hasAttribute("data-sesstab")){SESS_TAB=t.getAttribute("data-sesstab");return redraw()}
  if(t.hasAttribute("data-sessclose")){SESS_OPEN=null;return redraw()}
  if(t.hasAttribute("data-wrfold")){var f=wrFolded(),k=t.getAttribute("data-wrfold");if(f[k])delete f[k];else f[k]=1;try{localStorage.setItem(WR_FOLD_KEY,JSON.stringify(f))}catch(x){}}
  else{try{localStorage.setItem(SESS_MORE_KEY,t.getAttribute("data-sessmore"))}catch(x){}}
  Win.update("data",data);
 });
}
/** After a sessions redraw: scroll the turn a search hit opened into view once its detail is drawn. */
function wtSessAfter(ctx){
 wtFit(ctx);
 if(!SESS_SCROLL)return;
 var el=ctx.body.querySelector(".sd-hl");
 if(el){SESS_SCROLL=false;el.scrollIntoView({block:"center"})}
 else if(SESS_DET&&SESS_DET.id===SESS_OPEN)SESS_SCROLL=false;
}
/** The sessions card's header search: a box (name / id / model of the rows) with a mode toggle to search prompt text instead (server hits, plus the open timeline). */
function wtSessSearch(){
 return{id:"search",label:"search",title:"filter sessions, or search prompts",make:function(ctx){
  var w=document.createElement("span");w.className="wsearch";
  var inp=document.createElement("input");inp.type="search";inp.className="cbtn";inp.placeholder="search sessions";inp.setAttribute("aria-label","search sessions");inp.value=SESS_Q||"";
  var mode=document.createElement("button");mode.type="button";mode.className="cbtn";mode.setAttribute("aria-pressed",SESS_MODE==="prompts"?"true":"false");mode.textContent="prompts";mode.title="search inside the prompts of all sessions";
  var redraw=function(){Win.update("data",data)},tm=0;
  var run=function(){clearTimeout(tm);SESS_HITS=null;redraw();tm=setTimeout(function(){sessSearch(redraw)},400)};
  inp.addEventListener("input",function(){SESS_Q=inp.value;run()});
  mode.addEventListener("click",function(){SESS_MODE=SESS_MODE==="prompts"?"sessions":"prompts";mode.setAttribute("aria-pressed",SESS_MODE==="prompts"?"true":"false");inp.placeholder=SESS_MODE==="prompts"?"search prompts":"search sessions";run()});
  w.appendChild(inp);w.appendChild(mode);
  return w;
 }};
}
function wtView(build,after){return function(d){return d&&d.bySession?{html:build(d),after:after||wtFit}:null}}
function tablesDefaults(){
 var f=["data"],cards=[{id:"perf-group",type:"group",title:"Performance details",info:"per-pause cache verdicts, sessions and worker runs"},
  {id:"runs",type:"list",cls:"wm",title:"Worker runs",feeds:f,view:wtView(workersHtml),mount:wtWire,resize:wtFit},
  {id:"sessions",type:"list",cls:"wm",title:"Sessions by tokens",feeds:f,actions:[wtSessSearch()],view:wtView(sessionsHtml,wtSessAfter),mount:wtWire,resize:wtFit},
  {id:"pause",type:"table",title:"Cache verdict by pause",info:WT_INFO.pause,feeds:f,view:function(d){return d&&d.bySession?{html:pauseHtml(d),after:pauseFit}:null},resize:pauseFit}];
 return{parts:[[{tree:WinT.leaf("perf-group"),kids:{"perf-group":WinT.split("c",[WinT.leaf("speed"),WinT.leaf("runs"),WinT.leaf("sessions"),WinT.leaf("pause")],[0.25,0.25,0.25,0.25])},stDefaults:{},cards:cards},760]]};
}
`;
