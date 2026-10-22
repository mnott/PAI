/** cockpit-page/win — B11 `speed`, `pause`, `sessions`, `runs`: four cards on the general types, no type of their own (spec 7/B11).
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
/** Row-level disclosures: a click on a fold or "+N more" row stores its state and re-feeds the page's data. */
function wtWire(ctx){
 ctx.body.addEventListener("click",function(e){
  var t=e.target&&e.target.closest?e.target.closest("[data-wrfold],[data-sessmore]"):null;
  if(!t||!ctx.body.contains(t))return;
  e.preventDefault();
  if(t.hasAttribute("data-wrfold")){var f=wrFolded(),k=t.getAttribute("data-wrfold");if(f[k])delete f[k];else f[k]=1;try{localStorage.setItem(WR_FOLD_KEY,JSON.stringify(f))}catch(x){}}
  else{try{localStorage.setItem(SESS_MORE_KEY,t.getAttribute("data-sessmore"))}catch(x){}}
  Win.update("data",data);
 });
}
function wtView(build){return function(d){return d&&d.bySession?{html:build(d),after:wtFit}:null}}
function tablesDefaults(){
 var f=["data"],cards=[{id:"perf-group",type:"group",title:"Performance details",info:"per-pause cache verdicts, sessions and worker runs"},
  {id:"runs",type:"list",cls:"wm",title:"Worker runs",feeds:f,view:wtView(workersHtml),mount:wtWire,resize:wtFit},
  {id:"sessions",type:"table",title:"Sessions by tokens",feeds:f,view:wtView(sessionsHtml),mount:wtWire,resize:wtFit},
  {id:"pause",type:"table",title:"Cache verdict by pause",info:WT_INFO.pause,feeds:f,view:function(d){return d&&d.bySession?{html:pauseHtml(d),after:pauseFit}:null},resize:pauseFit}];
 return{parts:[[{tree:WinT.leaf("perf-group"),kids:{"perf-group":WinT.split("c",[WinT.leaf("runs"),WinT.leaf("sessions"),WinT.leaf("pause")],[0.38,0.38,0.24])},stDefaults:{},cards:cards},760]]};
}
`;
