/** cockpit-page/win — B9 `tokens` + `daily`: the two bar-chart cards (spec 7/B9, type `chart` of cards-system).
 *  Page-scope ES5 (needs the page's KINDS/mode/msel/DAILY_DAYS, label, tot, ringName, legendLine, colorOf,
 *  assignColors, stackedBarsSvg/twoToneSvg from script-charts, plus Win, WinT, WinA). Feed `data` (/cockpit/data).
 *  Cards: `tokens` (header actions: weighted/raw toggle with aria-pressed, a Select of models; slots svg, cap, legend)
 *  and `daily` (slots svg, cap, legend). The svg is drawn at the (w,h) the card's resize hands over; nothing measures
 *  the DOM. cards-system's `chart` type dispatches to WCHX[id] for these ids. */

/** The tokens/daily chart builders, the chart-type hooks WCHX and the shipped defaults. */
export const WIN_CHARTS_JS = String.raw`var WCH_INFO={tokens:"Tokens per time bucket, by kind. Weighted: tokens times Anthropic price ratios relative to fresh input (cache read, cache write, output); the same ratios apply to every other provider, whatever its real prices. Raw: token counts as reported.",daily:"Tokens per day per model."};
var WCH_BAND=62,WCHX={},WCHT={sel:null};
/** The explicit-pixel svg header of a card chart: user unit = css px. */
function wchHead(w,h){return'<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">'}
/** The models of the window, sorted; one colour assignment over every model shown anywhere (as the page's render). */
function wchModels(d){
 var models=[],um={};
 d.byModel.forEach(function(m){if(models.indexOf(m.model)<0)models.push(m.model)});models.sort();
 models.forEach(function(m){um[m]=1});
 Object.keys(d.daily.models).forEach(function(m){um[m]=1});
 d.byModel.forEach(function(m){um[m.model]=1});(d.speed||[]).forEach(function(r){um[r.model]=1});
 assignColors(Object.keys(um));
 return models;
}
/** The ecosystems of the models, sorted; a select value "eco:<name>" picks one, a plain value one model. */
function wchEcos(d,models){var e=d.ecosystems||{},u={};models.forEach(function(m){if(e[m])u[e[m]]=1});return Object.keys(u).sort()}
/** The models a selection stands for: the ecosystem's models, the one model, or [] for all. */
function wchSelModels(d,models,sel){
 if(!sel)return[];
 if(sel.indexOf("eco:")===0){var e=d.ecosystems||{},n=sel.slice(4);return models.filter(function(m){return e[m]===n})}
 return[sel];
}
/** Tokens: {html, cap, legend} for the payload at an explicit width/height (mode and msel are the page globals). */
function wchTokens(d,models,w,h){
 if(msel&&!wchSelModels(d,models,msel).length)msel="";
 var selm=wchSelModels(d,models,msel);
 var W=d.weights||{input:1,cacheWrite:1.25,cacheRead:.1,output:5},wt=mode==="weighted",head=wchHead(w,h),ref={id:"series"};
 var labs=d.series.map(function(b){return label(b.t,d.window)}),r;
 if(msel){
  var series=d.series.map(function(b){var o={};KINDS.forEach(function(k){o[k[0]]=0});Object.keys(b.models).forEach(function(m){if(selm.indexOf(m)<0)return;KINDS.forEach(function(k){o[k[0]]+=(b.models[m][k[0]]||0)*(wt?W[k[0]]:1)})});return o});
  r=stackedBarsSvg(ref,w,labs,series,KINDS.map(function(k){return k[0]}),h,head);
 }else{
  var buckets=d.series.map(function(b){var arr=[];models.forEach(function(m){var v=b.models[m];if(!v)return;var o={model:m,requests:v.requests||0};KINDS.forEach(function(k){o[k[0]]=(v[k[0]]||0)*(wt?W[k[0]]:1)});o.total=tot(o);if(o.total>0)arr.push(o)});return arr});
  var present={};buckets.forEach(function(a){a.forEach(function(s){present[s.model]=1})});
  models=models.filter(function(m){return present[m]});
  r=twoToneSvg(ref,w,labs,buckets,models,h,head);
 }
 var kinds=KINDS.map(function(k){return'<span><i style="background:'+k[2]+'"></i>'+k[1]+(wt?' x'+W[k[0]]:'')+'</span>'}).join("");
 var lg=legendLine("kinds",kinds+(msel?"":'<span><i style="background:'+colorOf("input")+';opacity:.25"></i>total (light)</span><span><i style="background:'+colorOf("input")+'"></i>non-cached (solid)</span>')+(msel?"":legendLine("models",models.map(function(m){return'<span><i style="background:'+colorOf(m)+'"></i>'+esc(ringName(m))+'</span>'}).join(""))))+(msel?"":"</div>");
 return{html:r.html,cap:r.cap,legend:lg};
}
/** Daily: {html, cap, legend} at an explicit width/height. */
function wchDaily(d,w,h){
 var dm=Object.keys(d.daily.models),dd=d.daily.days.slice(-DAILY_DAYS),n=d.daily.days.length;
 var ds=dd.map(function(t,i){var o={};dm.forEach(function(m){o[m]=d.daily.models[m][n-dd.length+i]});return o});
 var r=stackedBarsSvg({id:"daily"},w,dd.map(function(t){return new Date(t).toLocaleDateString([],{day:"numeric",month:"numeric"})}),ds,dm,h,wchHead(w,h));
 return{html:r.html,cap:r.cap,legend:dm.map(function(k){return'<span><i style="background:'+colorOf(k)+'"></i>'+esc(k)+'</span>'}).join("")};
}
function wchCap(c){return c?'<div class="cap dim">'+(typeof c==="string"?c:"idle hours compressed: the x axis is not time-linear")+'</div>':""}
/** Redraw one of the two cards from its stored payload and box. */
function wchDraw(ctx){
 var s=WCH[ctx.id];if(!s||!s.d||s.w<=0)return;
 var h=Math.max(80,s.h-WCH_BAND),o,lg=ctx.body&&ctx.body.querySelector('[data-k="legend"]');
 if(ctx.id==="tokens"){
  var models=wchModels(s.d);o=wchTokens(s.d,models,s.w,h);
  var sel=WCHT.sel;
  if(sel){var ecos=wchEcos(s.d,models);sel.setOptions([{value:"",label:"all models"}].concat(ecos.map(function(e){return{value:"eco:"+e,label:e,group:"ecosystem"}}),models.map(function(m){return ecos.length?{value:m,label:m,group:"model"}:{value:m,label:m}})));sel.setValue(msel)}
 }else{wchModels(s.d);o=wchDaily(s.d,s.w,h)}
 ctx.html("legend",o.legend);ctx.html("cap",wchCap(o.cap));
 // the legend is never scrolled: the svg takes the height left under the whole legend and the caption
 if(lg&&lg.offsetHeight>0){var h2=Math.max(80,s.h-16-lg.offsetHeight-12);if(h2!==h){h=h2;o=ctx.id==="tokens"?wchTokens(s.d,wchModels(s.d),s.w,h):wchDaily(s.d,s.w,h)}}
 ctx.html("svg",o.html);
}
var WCHX_MOUNT='<div class="wt-svg" data-k="svg"></div><div class="wt-cap" data-k="cap"></div><div class="legend wt-leg" data-k="legend"></div>';
WCHX.tokens=WCHX.daily={
 mount:function(ctx){ctx.body.innerHTML=WCHX_MOUNT},
 update:function(ctx,d){if(!d||!d.byModel||!d.daily)return;var s=WCH[ctx.id]||(WCH[ctx.id]={w:0,h:0,d:null});s.d=d;wchDraw(ctx)},
 resize:function(ctx,w,h){var s=WCH[ctx.id]||(WCH[ctx.id]={w:0,h:0,d:null});s.w=w;s.h=h;wchDraw(ctx)}
};
/** Mode button: sets the page mode (shared with the old section), saves it and redraws the card. */
function wchModeAct(m,label){
 return{id:"mode-"+m,label:label,title:m==="weighted"?"tokens times price ratios":"token counts as reported",
  pressed:function(){return mode===m},
  run:function(){mode=m;localStorage.setItem("cockpitMode",m);var c=Win.ctx("tokens");if(c)wchDraw(c);Win.update("data",data);Win.announce("tokens shown "+m)}};
}
/** The model filter as a card action: a styled Select (A9) built once. */
function wchSelAct(){
 return{id:"model",label:"model",title:"show one ecosystem or one model",
  make:function(ctx){
   WCHT.sel=WinA.Select({options:[{value:"",label:"all models"}],value:msel,ariaLabel:"ecosystem or model filter",onChange:function(v){msel=v;wchDraw(ctx)}});
   return WCHT.sel;
  }};
}
function chartsDefaults(){
 var cards=[{id:"tokens",type:"chart",title:"Tokens per bucket by kind",info:WCH_INFO.tokens,feeds:["data"],actions:[wchModeAct("weighted","weighted"),wchModeAct("raw","raw"),wchSelAct()]},
  {id:"daily",type:"chart",title:"Tokens per day per model ("+DAILY_DAYS+" d)",info:WCH_INFO.daily,feeds:["data"]},
  {id:"speed",type:"chart",title:"Speed per model",info:WT_INFO.speed,feeds:["data","system","limits"]}];
 cards.unshift({id:"tokens-group",type:"group",title:"Tokens",info:"token volume by bucket and per day"});
 return{parts:[[{tree:WinT.leaf("tokens-group"),kids:{"tokens-group":WinT.split("c",[WinT.leaf("tokens"),WinT.leaf("daily")],[0.5,0.5])},stDefaults:{},cards:cards},830]]};
}
`;
