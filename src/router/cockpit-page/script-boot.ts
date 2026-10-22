/** cockpit-page — script tail: the feeds, theme, startup wiring and polling. */

import { POOL_PANEL_JS } from "../pool-panel.js";
import { WIN_KEY } from "./win/store.js";
import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** Pool poll JS through the closing html tags. */
export const scriptBoot = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`${POOL_PANEL_JS}
/**
 * Hold-last-good: every poll goes through feed(). A failed fetch (network, timeout, non-2xx) or a payload the server marks
 * transient keeps the last good payload on screen; past HOLD_SEC the cards show the error (the degraded payload, else onErr).
 * A good payload is applied at once. A poll whose previous fetch (same url) is still out joins it, and at most 4 feeds (feed.out, feed.wait)
 * are out at once (the rest wait): a browser allows 6 connections per host, and slow polls holding all of them delayed a
 * click's own POST (registry validate/save) by seconds.
 */
var HOLD_SEC=${n(L.holdLastGoodSecs)},FEEDS={};
function feedHeld(F){return F.good!==null&&Date.now()-F.at<HOLD_SEC*1000}
function feedState(F){
 if(F.err&&!feedHeld(F)&&!F.shown){F.shown=1;if(F.degraded)F.apply(F.degraded);else if(F.onErr)F.onErr(F.err)}
}
function feedTick(){for(var k in FEEDS)if(FEEDS[k].err)feedState(FEEDS[k])}
function feed(key,url,secs,apply,onErr){
 var F=FEEDS[key]||(FEEDS[key]={good:null,at:0,t0:0,err:null,degraded:null,shown:0,secs:secs});
 F.apply=apply;F.onErr=onErr;
 function bad(why,j){
  if(!F.err){F.t0=Date.now();F.shown=0}
  F.err=why;F.degraded=j||null;feedState(F);
 }
 if(F.pend&&F.pendUrl===url)return F.pend;
 function go(){
  feed.out=(feed.out||0)+1;
  return fetch(url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}).then(function(j){
  if(j&&j.transient){
   bad(String(j.transient),j);
   if(F.good===null)apply(j);
   return}
  F.good=j;F.at=Date.now();F.err=null;F.degraded=null;F.shown=0;lastOk=F.at;apply(j);
 },function(e){bad(String((e&&e.message)||"fetch failed"),null)}).catch(function(){}).then(function(){feed.out--;var n=(feed.wait||[]).shift();if(n)n()});
 }
 F.pendUrl=url;
 F.pend=new Promise(function(res){if((feed.out||0)<4)go().then(res);else(feed.wait||(feed.wait=[])).push(function(){go().then(res)})}).then(function(){F.pend=null});
 return F.pend;
}
/** The build this page was served with; a poll carrying another one shows the reload link (once, until the reload). */
var BUILD=(document.querySelector('meta[name="cockpit-build"]')||{}).content;
function newerCheck(j){var a=$("newer");if(j&&j.build&&BUILD&&BUILD.charAt(0)!=="_"&&j.build!==BUILD&&a.hidden)a.hidden=false}
$("newer").onclick=function(e){e.preventDefault();location.reload()};
function loadQueue(){feed("queue","/cockpit/queue",["workers"],function(j){winFeedQueue(j)})}
function loadModels(){feed("models","/cockpit/models",["models"],function(j){mdl=j;winFeedModels(mdl)})}
function loadLimits(){feed("limits","/cockpit/limits",["cloud","routing","models","system","cache"],function(j){lim=j;winFeedLimits(lim);limitsSync(lim);winFeedCache()})}
function tabs(){var b=document.querySelectorAll("#tabs button");for(var i=0;i<b.length;i++){b[i].className=b[i].getAttribute("data-w")===win?"on":"";b[i].onclick=function(){win=this.getAttribute("data-w");localStorage.setItem("cockpitWin",win);tabs();load();loadSystem()}}}
/** Theme: the system's until the user picks one (only a click is saved); the button shows the other mode. */
function setTheme(t){document.documentElement.dataset.theme=t;var b=$("theme"),l=t==="dark"?"Light mode":"Dark mode";b.title=l;b.setAttribute("aria-label",l)}
$("theme").onclick=function(){var t=document.documentElement.dataset.theme==="dark"?"light":"dark";setTheme(t);try{localStorage.setItem("pai.cockpit.theme",t)}catch(e){}};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(e){var s=null;try{s=localStorage.getItem("pai.cockpit.theme")}catch(err){}if(!s)setTheme(e.matches?"dark":"light")});
setTheme(document.documentElement.dataset.theme==="dark"?"dark":"light");
/** Layout lock: per browser (localStorage, never sent to the router); other tabs follow through the storage event. */
function setLock(on){document.documentElement.classList.toggle("locked",on);var b=$("lock"),l=on?"unlock layout":"lock layout";b.textContent=on?"🔒":"🔓";b.title=l;b.setAttribute("aria-label",l);b.setAttribute("aria-pressed",on?"true":"false")}
$("lock").onclick=function(){var on=!document.documentElement.classList.contains("locked");setLock(on);try{localStorage.setItem("pai.cockpit.lock",on?"1":"0")}catch(e){}};
window.addEventListener("storage",function(e){if(e.key==="pai.cockpit.lock"&&e.storageArea===window.localStorage)setLock(e.newValue==="1")});
setLock(document.documentElement.classList.contains("locked"));
/** Save as default: this layout becomes what a device with none of its own starts from. Allowed while locked (the lock only stops edits). */
$("savedef").onclick=function(){var b=this,snap=Win.snapshot();b.classList.remove("ok","bad");
 fetch("/cockpit/layout-default",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(snap)}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);b.classList.add("ok");b.title="saved as the default layout"},function(){b.classList.add("bad");b.title="could not save the default layout"}).catch(function(){b.classList.add("bad")});
 setTimeout(function(){b.classList.remove("ok","bad");b.title="save this layout as the default for all devices"},2500)};
tabs();
/** The reset button drops this device's layout; the reload starts again from the default (the saved one, else the built-in). */
$("reset").onclick=function(){try{localStorage.removeItem(${JSON.stringify(WIN_KEY)})}catch(e){}location.reload()};
load();loadSystem();loadLimits();loadModels();loadPool();loadQueue();loadMemory();
setInterval(function(){load();loadSystem()},${L.pollMs});setInterval(loadLimits,${L.limitsPollMs});setInterval(loadModels,${L.pollMs});setInterval(loadPool,${L.poolPollMs});setInterval(loadQueue,${L.pollMs});setInterval(loadMemory,${L.memoryPollMs});setInterval(tick,${L.clockTickMs});setInterval(feedTick,${L.clockTickMs});
})();
</script></body></html>
`;
