/** cockpit-page/win — styled Select and Menu (spec 5.1). Pure ES5 inside a string. */

/** The page-side shapes the ES5 code mirrors (types here are for the TS side only). */
export type WinSelectOption = { value: string; label: string; hint?: string; group?: string; disabled?: boolean };
export type WinSelectApi = HTMLElement & { setOptions(o: WinSelectOption[]): void; setValue(v: string | null): void; setDisabled(on: boolean, reason?: string): void };
export type WinMenuItem = { label: string; title?: string; disabled?: boolean; run?: () => void };
export type WinMenuApi = HTMLElement & { setMenu(items: WinMenuItem[]): void };

/** One popup, appended to <body>, positioned under the button (flips up when there is no room).
 *  Shared by Select and Menu; both themes come from the CSS variables only. */
export const WIN_SELECT_JS = String.raw`var _wcur=null;
function _wclosePop(){if(_wcur&&_wcur.pop.parentNode)document.body.removeChild(_wcur.pop);_wcur=null}
document.addEventListener("mousedown",function(e){
 if(!_wcur)return;
 var t=e.target,c=_wcur;
 if(t===c.btn||c.btn.contains(t)||t===c.pop||c.pop.contains(t))return;
 c.close(false);
});
window.addEventListener("resize",function(){if(_wcur)_wpos(_wcur.pop,_wcur.btn)});
window.addEventListener("scroll",function(){if(_wcur)_wpos(_wcur.pop,_wcur.btn)},true);
function _wpos(pop,btn){
 var r=btn.getBoundingClientRect(),vw=window.innerWidth,vh=window.innerHeight;
 pop.style.visibility="hidden";pop.style.maxHeight="";
 if(pop.offsetWidth<r.width)pop.style.minWidth=r.width+"px";
 var mh=Math.max(120,vh-12);
 if(r.bottom+4+pop.scrollHeight<=vh)pop.style.maxHeight=(vh-r.bottom-8)+"px";
 else if(r.top-4>=mh)pop.style.maxHeight=(r.top-8)+"px";
 else pop.style.maxHeight=mh+"px";
 pop.style.visibility="";
 var top=r.bottom+4,left=r.left;
 if(top+pop.offsetHeight>vh)top=Math.max(4,r.top-4-pop.offsetHeight);
 if(left+pop.offsetWidth>vw-4)left=Math.max(4,vw-4-pop.offsetWidth);
 pop.style.left=left+"px";pop.style.top=top+"px";
}
function _wopenPop(btn,pop,close){
 if(_wcur&&_wcur.pop!==pop)_wcur.close(false);
 if(!pop.parentNode)document.body.appendChild(pop);
 _wcur={btn:btn,pop:pop,close:close};btn.setAttribute("aria-expanded","true");
 _wpos(pop,btn);
}
function _witemEl(o,i,sel){
 var el=document.createElement("div");
 el.className="wopt"+(o.disabled?" wdis":"")+(sel?" wsel":"");
 el.setAttribute("role","option");el.setAttribute("aria-selected","false");
 el.id="wopt"+i;
 var lab=document.createElement("span");lab.className="wolab";lab.textContent=o.label;el.appendChild(lab);
 if(o.hint){var h=document.createElement("span");h.className="wohint";h.textContent=o.hint;el.appendChild(h)}
 if(o.disabled)el.setAttribute("aria-disabled","true");
 return el;
}
/** Select.create({options,value,placeholder,ariaLabel,onChange}) -> button element carrying .setOptions/.setValue/.setDisabled.
 *  No native <select>: the popup is a styled listbox on <body>. */
function Select(o){
 o=o||{};
 var btn=document.createElement("button");
 btn.type="button";btn.className="wctl wsel-btn";
 btn.setAttribute("aria-haspopup","listbox");btn.setAttribute("aria-expanded","false");
 if(o.ariaLabel)btn.setAttribute("aria-label",o.ariaLabel);
 var lab=document.createElement("span");lab.className="wv";btn.appendChild(lab);
 var car=document.createElement("span");car.className="wcar";car.textContent="▾";btn.appendChild(car);
 var pop=document.createElement("div");pop.className="wpop";pop.setAttribute("role","listbox");
 if(o.ariaLabel)pop.setAttribute("aria-label",o.ariaLabel);
 var opts=[],val=null,open=false,dis=false,reason="",onChange=o.onChange||null;
 function labelOf(v){for(var i=0;i<opts.length;i++)if(opts[i].value===v)return opts[i].label;return null}
 function paintBtn(){
  var l=labelOf(val);
  lab.textContent=l!==null?l:(o.placeholder||"");
  btn.classList.toggle("wph",l===null);
 }
 function items(){return pop.querySelectorAll("[data-i]")}
 function setActive(i){
  var it=items();
  for(var j=0;j<it.length;j++){
   it[j].classList.toggle("wact",j===i);
   it[j].setAttribute("aria-selected",j===i?"true":"false");
  }
  if(i>=0)btn.setAttribute("aria-activedescendant",it[i].id);else btn.removeAttribute("aria-activedescendant");
 }
 function firstEnabled(from,dir){
  for(var k=from;k>=0&&k<opts.length;k+=dir)if(!opts[k].disabled)return k;
  return -1;
 }
 function openP(){
  if(dis||open)return;
  open=true;_wopenPop(btn,pop,closeP);
  var act=-1;
  for(var i=0;i<opts.length;i++)if(opts[i].value===val&&!opts[i].disabled){act=i;break}
  if(act<0)act=firstEnabled(0,1);
  setActive(act);btn.focus();
 }
 function closeP(back){
  if(!open)return;
  open=false;_wclosePop();btn.setAttribute("aria-expanded","false");
  if(back)btn.focus();
 }
 function pick(i){
  var o=opts[i];if(!o||o.disabled)return;
  val=o.value;paintBtn();
  // refresh the marks (the old selection loses it) without closing: pick fires onChange once
  render();
  closeP(true);
  if(onChange)onChange(o.value);
 }
 function render(){
  pop.textContent="";
  var lastG=null;
  for(var i=0;i<opts.length;i++){
   var o=opts[i];
   if(o.group&&o.group!==lastG){var g=document.createElement("div");g.className="wgrp";g.textContent=o.group;pop.appendChild(g)}
   lastG=o.group||null;
   var el=_witemEl(o,i,o.value===val);el.setAttribute("data-i",String(i));pop.appendChild(el);
  }
  if(open)_wpos(pop,btn);
 }
 btn.addEventListener("click",function(){open?closeP(true):openP()});
 btn.addEventListener("keydown",function(e){
  var k=e.key;
  if(!open){
   if(k==="Enter"||k===" "||k==="ArrowDown"){e.preventDefault();openP()}
   return;
  }
  if(k==="Escape"){e.preventDefault();closeP(true);return}
  if(k==="ArrowDown"||k==="ArrowUp"){
   e.preventDefault();
   var cur=_wactIndex(),step=k==="ArrowDown"?1:-1;
   var nx=firstEnabled(cur<0?(step>0?0:opts.length-1):cur+step,step);
   if(nx<0)nx=firstEnabled(step>0?0:opts.length-1,step);
   setActive(nx);
   return;
  }
  if(k==="Home"){e.preventDefault();setActive(firstEnabled(0,1));return}
  if(k==="End"){e.preventDefault();setActive(firstEnabled(opts.length-1,-1));return}
  if(k==="Enter"){e.preventDefault();pick(_wactIndex());return}
  if(k.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
   var l=k.toLowerCase(),n=opts.length,cur=_wactIndex();
   for(var t=1;t<=n;t++){var i=(cur+t)%n;if(!opts[i].disabled&&String(opts[i].label).toLowerCase().indexOf(l)===0){setActive(i);e.preventDefault();return}}
  }
 });
 function _wactIndex(){
  var it=items();
  for(var j=0;j<it.length;j++)if(it[j].classList.contains("wact"))return +it[j].getAttribute("data-i");
  return -1;
 }
 pop.addEventListener("mousedown",function(e){e.preventDefault()});
 pop.addEventListener("click",function(e){
  var el=e.target;
  while(el&&el!==pop&&!el.getAttribute("data-i"))el=el.parentNode;
  if(el&&el!==pop)pick(+el.getAttribute("data-i"));
 });
 var api=btn;
 api.setOptions=function(o2){opts=o2||[];render();if(open)setActive(_wactIndex())};
 api.setValue=function(v){val=v;paintBtn();if(open){render();setActive(_wactIndex())}};
 api.setDisabled=function(on,r){dis=!!on;reason=r||"";btn.disabled=dis;if(reason)btn.title=reason;else btn.removeAttribute("title");if(dis)closeP(false)};
 api.setOptions(o.options||[]);api.setValue(o.value==null?null:o.value);
 return btn;
}
Select.create=function(o){return Select(o)};
/** Menu({items:[{label,title?,disabled?,run?}],ariaLabel}) -> button element; action items, no value. */
function Menu(o){
 o=o||{};
 var btn=document.createElement("button");
 btn.type="button";btn.className="wctl wmenu-btn";
 btn.setAttribute("aria-haspopup","menu");btn.setAttribute("aria-expanded","false");
 if(o.ariaLabel)btn.setAttribute("aria-label",o.ariaLabel);
 var lab=document.createElement("span");lab.textContent=o.label||"⋯";btn.appendChild(lab);
 var pop=document.createElement("div");pop.className="wpop";pop.setAttribute("role","menu");
 var items=[],open=false;
 function els(){return pop.querySelectorAll("[data-i]")}
 function setActive(i){
  var it=els();
  for(var j=0;j<it.length;j++)it[j].classList.toggle("wact",j===i);
  var a=i>=0?pop.querySelector('[data-i="'+i+'"]'):null;
  if(a)btn.setAttribute("aria-activedescendant",a.id);else btn.removeAttribute("aria-activedescendant");
 }
 function actIndex(){var it=els();for(var j=0;j<it.length;j++)if(it[j].classList.contains("wact"))return +it[j].getAttribute("data-i");return -1}
 function firstEnabled(from,dir){for(var k=from;k>=0&&k<items.length;k+=dir)if(!items[k].disabled)return k;return -1}
 function openP(){if(open)return;open=true;_wopenPop(btn,pop,closeP);setActive(firstEnabled(0,1));btn.focus()}
 function closeP(back){if(!open)return;open=false;_wclosePop();btn.setAttribute("aria-expanded","false");btn.removeAttribute("aria-activedescendant");if(back)btn.focus()}
 function run(i){var it=items[i];if(!it||it.disabled)return;closeP(true);if(it.run)it.run()}
 function setMenu(list){
  items=list||[];pop.textContent="";
  for(var i=0;i<items.length;i++){
   var el=document.createElement("div");el.className="wopt"+(items[i].disabled?" wdis":"");
   el.setAttribute("role","menuitem");if(items[i].title)el.title=items[i].title;
   el.setAttribute("data-i",String(i));el.id="wmi"+i;
   if(items[i].disabled)el.setAttribute("aria-disabled","true");
   var s=document.createElement("span");s.className="wolab";s.textContent=items[i].label;el.appendChild(s);
   pop.appendChild(el);
  }
  if(open)_wpos(pop,btn);
 }
 btn.addEventListener("click",function(){open?closeP(true):openP()});
 btn.addEventListener("keydown",function(e){
  var k=e.key;
  if(!open){if(k==="Enter"||k===" "||k==="ArrowDown"){e.preventDefault();openP()}return}
  if(k==="Escape"){e.preventDefault();closeP(true);return}
  if(k==="ArrowDown"||k==="ArrowUp"){e.preventDefault();var cur=actIndex(),step=k==="ArrowDown"?1:-1;setActive(firstEnabled(cur<0?(step>0?0:items.length-1):cur+step,step));return}
  if(k==="Home"){e.preventDefault();setActive(firstEnabled(0,1));return}
  if(k==="End"){e.preventDefault();setActive(firstEnabled(items.length-1,-1));return}
  if(k==="Enter"){e.preventDefault();run(actIndex());return}
 });
 pop.addEventListener("mousedown",function(e){e.preventDefault()});
 pop.addEventListener("click",function(e){
  var el=e.target;
  while(el&&el!==pop&&!el.getAttribute("data-i"))el=el.parentNode;
  if(el&&el!==pop)run(+el.getAttribute("data-i"));
 });
 btn.setMenu=setMenu;
 btn.setMenu(o.items||[]);
 return btn;
}
Menu.create=function(o){return Menu(o)};
`;

/** Styles for the win controls (new block; old rules untouched until W-cut). Theme via variables only. */
export const winSelectCss = (): string => String.raw`.wctl{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.wctl:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.wctl[disabled]{opacity:.5;cursor:default}
.wctl .wv{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.wctl.wph .wv{color:var(--dim)}
.wctl .wcar{color:var(--dim);font-size:10px}
.wpop{position:fixed;z-index:30;background:var(--card);border:1px solid var(--line);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);overflow:auto;padding:4px;min-width:120px}
.wopt{display:flex;align-items:center;gap:10px;padding:3px 8px;border-radius:5px;cursor:pointer;white-space:nowrap}
.wopt .wolab{min-width:0;overflow:hidden;text-overflow:ellipsis}
.wopt .wohint{margin-left:auto;color:var(--dim);font-size:11px;white-space:nowrap}
.wopt.wact{background:color-mix(in srgb,var(--acc) 18%,var(--card))}
.wopt.wsel{outline:1px solid var(--acc)}
.wopt.wdis{color:var(--dim);cursor:default}
.wgrp{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:4px 8px 2px}
`;
