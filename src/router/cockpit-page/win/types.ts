/** cockpit-page/win — the generic card types kv, table, note, list, metric (and its metricm variant): one owner, no knowledge of any section or card id.
 *  Page-scope ES5; needs `Win` from WIN_CARD_JS. Each type draws only the data its spec's view(payload, ctx) returns
 *  (card.ts feedCard); a spec of these types without a view draws nothing. The data (keys all optional):
 *    kv    {v, s, t, status:[kind,text]}  big html value, sub html line, title attr of the sub line, header status
 *    table {html}                         the table markup
 *    note  {text, title}                  one text line, its title attr (null clears it)
 *    list  {html} | {rows:{items,key,make,fill}}   html, or a keyed row list (ctx.list)
 *    metric {v, u, s, x(html), spark(html), cls:{warn,bad}}  big value, unit, sub line, extra html, sparkline html, classes of the value
 *  and on every type: title (card title), status ([kind,text]), after(ctx) (run after drawing; the section's own wiring).
 *  A spec may also carry mount(ctx) (run once after the markup exists), resize(ctx,w,h) (table, list) and, for the list, cls (the slot's class, default "wr"). */

export const WIN_TYPES_JS = String.raw`function winDrawCommon(ctx,d){
 if(d.title!==undefined)ctx.title(d.title);
 if(d.status)ctx.status(d.status[0],d.status[1]);
 if(d.after)d.after(ctx);
}
function winSpecMount(ctx){if(ctx.spec&&ctx.spec.mount)ctx.spec.mount(ctx)}
Win.registerType("kv",{minW:150,minH:80,defaultH:96,viewed:true,
 mount:function(ctx){ctx.body.innerHTML='<div class="wm"><b class="wm-v" data-k="v"></b><span class="wm-s" data-k="s"></span></div>';winSpecMount(ctx)},
 update:function(ctx,d){
  ctx.html("v",d.v);ctx.html("s",d.s);
  if("t" in d)ctx.attr("s","title",d.t);
  winDrawCommon(ctx,d);
 }});
Win.registerType("table",{minW:300,minH:56,defaultH:160,viewed:true,
 resize:function(ctx,w,h){if(ctx.spec&&ctx.spec.resize)ctx.spec.resize(ctx,w,h)},
 mount:function(ctx){ctx.body.innerHTML='<div class="tw" data-k="t"></div>';winSpecMount(ctx)},
 update:function(ctx,d){
  if(d.title!==undefined)ctx.title(d.title);
  ctx.html("t",d.html);
  winDrawCommon(ctx,{status:d.status,after:d.after});
 }});
Win.registerType("note",{minW:150,minH:48,defaultH:60,viewed:true,
 mount:function(ctx){ctx.body.innerHTML='<div class="wm"><span class="wm-s" data-k="n"></span></div>';winSpecMount(ctx)},
 update:function(ctx,d){
  ctx.text("n",d.text);
  if("title" in d)ctx.attr("n","title",d.title);
  winDrawCommon(ctx,{status:d.status,after:d.after});
 }});
Win.registerType("list",{minW:200,minH:60,defaultH:90,viewed:true,
 resize:function(ctx,w,h){if(ctx.spec&&ctx.spec.resize)ctx.spec.resize(ctx,w,h)},
 mount:function(ctx){ctx.body.innerHTML='<div class="'+((ctx.spec&&ctx.spec.cls)||"wr")+'" data-k="l"></div>';winSpecMount(ctx)},
 update:function(ctx,d){
  if(d.title!==undefined)ctx.title(d.title);
  if(d.rows)ctx.list("l",d.rows.items,d.rows.key,d.rows.make,d.rows.fill);
  else ctx.html("l",d.html);
  winDrawCommon(ctx,{status:d.status,after:d.after});
 }});
var WIN_METRIC={minW:100,minH:76,defaultH:96,viewed:true,
 mount:function(ctx){ctx.body.innerHTML='<div class="wm"><div class="wm-sp" data-k="spark"></div><b class="wm-v" data-k="v"></b><small class="wm-u" data-k="u"></small><span class="wm-s" data-k="s"></span><div class="wm-x" data-k="x" style="font-size:11px;overflow:auto"></div></div>';winSpecMount(ctx)},
 update:function(ctx,d){
  if("v" in d)ctx.text("v",d.v);
  if("u" in d)ctx.text("u",d.u);
  if("s" in d)ctx.text("s",d.s);
  if("tip" in d)ctx.attr("s","title",d.tip);
  if("x" in d)ctx.html("x",d.x);
  if("spark" in d)ctx.html("spark",d.spark);
  if(d.cls)for(var k in d.cls)ctx.cls("v",k,d.cls[k]);
  winDrawCommon(ctx,d);
 }};
Win.registerType("metric",WIN_METRIC);
/** metricm: the same card for the memory group, whose sub lines wrap to three rows. */
Win.registerType("metricm",Object.assign({},WIN_METRIC,{minH:90,defaultH:140}));
`;
