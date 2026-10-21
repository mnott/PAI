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
var mdl=null,BLUR_CANCEL_MS=400;
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
`;
