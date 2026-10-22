/** cockpit-page/win — `kpis`: the `metric` card type and the "Totals in this window" group.
 *  Page-scope ES5 (runs after scriptCore, so fmt/cls/ERROR_WARN/ERROR_BAD are in scope) and needs
 *  `Win` from WIN_CARD_JS. Feed `data` (/cockpit/data); the six cards are `kpis.requests|input|
 *  output|cache-read|cache-write|errors` in one row inside the group `kpis`. */

/** The shipped default for this section: group `kpis` as the only root band, one row of six metrics. */
export const WIN_KPIS_JS = String.raw`var KPI_INFO="Requests, tokens and errors over the selected window (1 hour / Today / Week).";
var KPI_IDS=["requests","input","output","cache-read","cache-write","errors"];
var KPI_TITLES={"requests":"requests","input":"input","output":"output","cache-read":"cache read","cache-write":"cache write","errors":"errors"};
/** One metric of the totals: {v: text, sub: text, tone: "" | "warn" | "bad"}. */
function kpiMetric(key,t){
 var ex=t.errors/Math.max(1,t.requests);
 if(key==="requests")return{v:fmt(t.requests),sub:"",tone:""};
 if(key==="input")return{v:fmt(t.input),sub:"",tone:""};
 if(key==="output")return{v:fmt(t.output),sub:"",tone:""};
 if(key==="cache-read")return{v:fmt(t.cacheRead),sub:"",tone:""};
 if(key==="cache-write")return{v:fmt(t.cacheWrite),sub:"",tone:""};
 return{v:String(t.errors),sub:(ex*100).toFixed(ex<0.1?1:0)+"% of requests",tone:cls(ex,ERROR_WARN,ERROR_BAD)};
}
/** The kpis cards' view: the card id after "kpis." picks the metric. */
function kpiView(d,ctx){
 if(!d||!d.totals)return null;
 var m=kpiMetric(ctx.id.slice(5),d.totals);
 return{v:m.v,s:m.sub,cls:{warn:m.tone==="warn",bad:m.tone==="bad"}};
}
/** The group's one row needs the group box to fit it: header + metric body. */
Win.registerType("group",{accepts:["*"],minW:220,minH:68,defaultH:124});
function kpiDefaults(){
 var cards=[{id:"kpis",type:"group",title:"Totals in this window",info:KPI_INFO}],ch=[],sz=[],i;
 for(i=0;i<KPI_IDS.length;i++){
  cards.push({id:"kpis."+KPI_IDS[i],type:"metric",title:KPI_TITLES[KPI_IDS[i]],feeds:["data"],view:kpiView});
  ch.push(WinT.leaf("kpis."+KPI_IDS[i]));sz.push(1/KPI_IDS.length);
 }
 return{tree:WinT.leaf("kpis"),kids:{kpis:WinT.split("r",ch,sz)},stDefaults:{},cards:cards};
}
`;
