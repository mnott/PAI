/** cockpit-page — script: limits, routing and the Models section. */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** gauge through the model-card job watcher. `ratio` is workers.yaml budget.cloudUnderPace.ratio, baked at page build. */
export const scriptModels = (L: CockpitLayout, n: Num, q: Str, hex: Str, ratio: number): string => String.raw`var CLOUD_RATIO=${n(ratio)};
function gauge(l,w,age){
 var p=Math.max(0,Math.min(100,w.percent)),r=44,cx=60,cy=56,a=Math.PI*p/100;
 var x=cx-r*Math.cos(a),y=cy-r*Math.sin(a);
 var arc='<path d="M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+(cx+r)+' '+cy+'" fill="none" stroke="var(--line)" stroke-width="10" stroke-linecap="round"/>';
 var pc=typeof w.pace==="number"?w.pace:null,thr=pc!==null?CLOUD_RATIO*pc:null;
 var fill=thr!==null?(p<thr?"var(--ok)":p<=pc?"var(--warn)":"var(--bad)"):sev(p);
 if(p>0)arc+='<path d="M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+x.toFixed(1)+' '+y.toFixed(1)+'" fill="none" stroke="'+fill+'" stroke-width="10" stroke-linecap="round"/>';
 var tick="",pnote="";
 if(pc!==null){var pa=Math.PI*Math.max(0,Math.min(100,pc))/100,c=Math.cos(pa),sn=Math.sin(pa);
  // one red radial tick across the ring's stroke only (r-4 to r+4): never into the centre, never over the number
  tick='<line x1="'+(cx-(r-4)*c).toFixed(1)+'" y1="'+(cy-(r-4)*sn).toFixed(1)+'" x2="'+(cx+(r+4)*c).toFixed(1)+'" y2="'+(cy+(r+4)*sn).toFixed(1)+'" stroke="var(--bad)" stroke-width="3"><title>pace '+Math.round(pc)+'% · cloud first below '+Math.round(thr)+'%</title></line>';
  var under=w.percent<=pc;pnote='<div class="s" title="pace = elapsed share of the window">used '+Math.round(w.percent)+'% · pace '+Math.round(pc)+'% · <span class="'+(under?'ok':'warn')+'">'+(under?'under pace':'over pace')+'</span></div>'}
 return '<div class="gauge"><svg width="120" height="70" viewBox="0 0 120 70">'+arc+tick+'<text x="60" y="54" text-anchor="middle" style="font-size:16px;font-weight:600;fill:var(--fg)">'+Math.round(w.percent)+'%</text></svg>'+
  '<div class="n">'+esc(l.provider)+' '+esc(w.name)+(age?' <span class="warn" title="'+esc(l.error||"")+'">· '+esc(age)+' old</span>':'')+(w.estimated?' <span class="warn">estimated</span>':'')+'</div>'+
  '<div class="s" data-reset="'+(w.resetAt||0)+'">'+(w.resetAt?'resets in '+dur(w.resetAt-Date.now()):'reset unknown')+'</div>'+pnote+'</div>';
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
