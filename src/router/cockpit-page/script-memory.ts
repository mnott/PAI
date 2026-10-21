/** cockpit-page — script: the Memory section (index/embed state, passes, backend, run actions). */

import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

export const scriptMemory = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`var mem=null;
function memDur(s){if(s==null)return"–";s=Math.round(s);return s<90?s+" s":s<5400?Math.floor(s/60)+" m "+String(s%60).padStart(2,"0")+" s":Math.floor(s/3600)+" h "+String(Math.floor(s%3600/60)).padStart(2,"0")+" m"}
function memAt(ms){return ms?new Date(ms).toLocaleString():"never"}
function memLvl(l){return l==="red"?"bad":l==="amber"?"warn":"ok"}
/** The run line: what runs, who started it, chunks done of the backlog at start, rate, ETA, elapsed, the log's last line. */
function memRunLine(r){
 var p=r.backlogStart!=null&&r.backlogStart>0?" ("+(100*r.done/r.backlogStart).toFixed(1)+"%)":"";
 var out=r.kind+" running (started by "+r.by+")";
 if(r.kind==="embed")out+=" · "+fmt(r.done)+(r.backlogStart!=null?" / "+fmt(r.backlogStart):"")+" chunks"+p;
 if(r.rate!=null)out+=" · "+r.rate+"/s";
 if(r.etaSec!=null)out+=" · ETA "+memDur(r.etaSec);
 out+=" · "+memDur(r.elapsedSec);
 if(r.tail)out+=" · "+r.tail;
 return out;
}
function memClock(ms){return new Date(ms).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
function memBound(b){return b?b.backend+(b.model?" / "+b.model:""):"none"}
function loadMemory(){feed("memory","/cockpit/memory",["memory"],function(j){mem=j;winFeedMemory(j)},function(){mem=null})}
`;
