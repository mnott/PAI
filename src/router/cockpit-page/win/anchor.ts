/** cockpit-page/win — page-wide anchor keeper: a safety net, not the mechanism.
 *  Pure ES5 inside a string, testable in a page with a `main` holding `.card` elements.
 *  Tracks the topmost card whose top is at or below the viewport top ({id, offset, y}) on every
 *  scroll. A MutationObserver on main (childList, subtree, attributes style/class/hidden)
 *  schedules one check per animation frame (timer fallback when frames are paused): when the tracked card's document position (offset + scrollY) drifted by 1 px or more, scrollBy the difference (logged as
 *  "[anchor] drift N px after <mutation>" with ?debug=scroll). anchorKeep(fn) runs a
 *  structural operation, measures before/after the same way and corrects immediately.
 *  ?anchor=off makes anchorKeep run fn bare and installs no observer.
 *  anchorInit(doc, win, main) -> keeper {track, check, keep, stop}; also sets the page
 *  keeper that the global anchorKeep(fn) uses. */
export const WIN_ANCHOR_JS = String.raw`var _ANCHOR=null;
function anchorFlag(win,k,v){return new RegExp("[?&]"+k+"="+v+"(&|$)").test(win.location.search)}
/** Topmost card with top >= 0 (else the last card above the viewport): {el,id,offset}. Cards without a box (display:none, hidden) never anchor. */
function anchorPick(main){
 var cs=main.querySelectorAll(".card"),best=null,last=null,i,r;
 for(i=0;i<cs.length;i++){
  if(cs[i].hidden)continue;
  r=cs[i].getBoundingClientRect();
  if(!r.width&&!r.height)continue;
  last=cs[i];
  if(r.top>=0&&(!best||r.top<best.top))best={el:cs[i],top:r.top};
 }
 var el=best?best.el:last;
 if(!el)return null;
 return{el:el,id:el.getAttribute("data-card")||el.id||"",offset:el.getBoundingClientRect().top,y:main.ownerDocument.defaultView.scrollY};
}
function anchorInit(doc,win,main){
 var A={off:anchorFlag(win,"anchor","off"),debug:anchorFlag(win,"debug","scroll"),tracked:null,lastScroll:-1e9,selfY:null,pending:0,reason:"",mo:null,drifts:0};
 function now(){return win.performance?win.performance.now():Date.now()}
 A.track=function(){A.tracked=anchorPick(main)};
 // measure the tracked card again; connected check keeps a removed anchor from steering
 A.drift=function(){
  var t=A.tracked;
  if(!t||!t.el.isConnected)return 0;
  return t.el.getBoundingClientRect().top+win.scrollY-t.offset-t.y;
 };
 A.fix=function(why){
  var d=A.drift();
  if(Math.abs(d)>=1){
   A.drifts++;
   if(A.debug&&win.console)win.console.log("[anchor] drift "+Math.round(d)+" px after "+why);
   win.scrollBy(0,d);
   A.selfY=win.scrollY;
  }
  A.track();
  return d;
 };
 // mutation-driven safety check; drift is measured in document space, so a scroll (the user's, or one whose event is still queued) is not drift
 A.check=function(){
  A.pending=0;
  return A.fix(A.reason||"mutation");
 };
// rAF, or a timer when frames are paused (hidden tab): whichever comes first runs the check once
 A.run=function(){if(A.pending)A.check()};
 A.keep=function(fn){
  if(A.off)return fn();
  A.track();
  var ret=fn();
  A.fix("structural change");
  return ret;
 };
 A.stop=function(){if(A.mo)A.mo.disconnect();win.removeEventListener("scroll",A.onScroll)};
 // our own scrollBy fires a scroll event too: it is not the user scrolling
 A.onScroll=function(){A.selfY=null;A.fix("scroll")};
 if(!A.off){
  win.addEventListener("scroll",A.onScroll,{passive:true});
  A.track();
  A.mo=new win.MutationObserver(function(ms){
   var m=ms[0];
   A.reason=(m.type==="attributes"?"attr "+m.attributeName:m.type)+" on "+(m.target.nodeName||"").toLowerCase();
   if(!A.pending){A.pending=1;win.requestAnimationFrame(A.run);win.setTimeout(A.run,100)}
  });
  A.mo.observe(main,{childList:true,subtree:true,attributes:true,attributeFilter:["style","class","hidden"]});
 }
 _ANCHOR=A;
 return A;
}
function anchorKeep(fn){return _ANCHOR?_ANCHOR.keep(fn):fn()}
`;
