/** cockpit-page/win — info popover (spec 2.4): ⓘ anchor, popup on <body>, replaces the
 *  .tip CSS tooltip so no card's overflow can clip it. Pure ES5 inside a string. */

/** Info popover, testable with new Function. One popup element lives on document.body
 *  (created on first show, reused after), positioned from the anchor's rect: below the
 *  anchor, flipped above when there is no room below, clamped to the viewport. Shows on
 *  hover and focus of the anchor, click toggles, Esc hides (and returns focus), pointer
 *  leave / blur hide. The text lives in the popup, never in a ::after of the anchor, so
 *  a card with overflow:hidden cannot clip it.
 *  winInfoHtml(text) -> the anchor markup: <span class="win-info" tabindex="0"
 *  role="button" aria-describedby="win-info-pop">ⓘ</span>.
 *  winInfoWire(doc, win) attaches the listeners on doc (win = the window for scroll and
 *  resize repositioning); call once at boot. */
export const WIN_INFO_JS = String.raw`var WIN_INFO_ID="win-info-pop";
function winInfoHtml(t){
 var e=String(t==null?"":t).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
 return'<span class="win-info" tabindex="0" role="button" aria-describedby="'+WIN_INFO_ID+'" data-info="'+e+'">ⓘ</span>';
}
function winInfoPopup(doc){
 var p=doc.getElementById(WIN_INFO_ID);
 if(!p){
  p=doc.createElement("div");
  p.id=WIN_INFO_ID;p.setAttribute("role","tooltip");p.hidden=true;
  doc.body.appendChild(p);
 }
 return p;
}
/** Place the popup under the anchor rect; flip above when it would pass the viewport
 *  bottom; clamp horizontally to the viewport. */
function winInfoPlace(p,rect,win){
 var vw=win.innerWidth,vh=win.innerHeight;
 // offsetWidth/Height are 0 while the popup is hidden: unhide before measuring
 p.hidden=false;
 var w=p.offsetWidth,h=p.offsetHeight;
 var left=rect.left;
 if(left+w>vw-8)left=Math.max(8,vw-8-w);
 // below the anchor, clear of its box; flip above only when there is no room below
 var top=rect.bottom+6;
 if(top+h>vh-8&&rect.top-6-h>=8)top=rect.top-6-h;
 p.style.left=Math.round(left)+"px";p.style.top=Math.round(top)+"px";
}
function winInfoShow(doc,win,anchor){
 var p=winInfoPopup(doc);
 var t=anchor.getAttribute("data-info")||"";
 if(p.textContent!==t)p.textContent=t;
 p.hidden=false;
 anchor.setAttribute("aria-expanded","true");
 winInfoPlace(p,anchor.getBoundingClientRect(),win);
}
function winInfoHide(doc,anchor){
 var p=doc.getElementById(WIN_INFO_ID);
 if(p)p.hidden=true;
 if(anchor)anchor.setAttribute("aria-expanded","false");
}
/** One delegated listener set on doc: hover (pointerenter/leave), focus/blur, click
 *  toggles, Esc hides and returns focus to the anchor. Scroll or resize moves the
 *  anchor: reposition while open. */
function winInfoWire(doc,win){
 var open=null,quiet=false;
 function over(e){if(quiet)return;var a=e.target;var el=a&&a.closest?a.closest(".win-info"):null;if(el){winInfoShow(doc,win,el);open=el}}
 function out(e){var a=e.target;var el=a&&a.closest?a.closest(".win-info"):null;if(el&&el===open){winInfoHide(doc,el);open=null}}
 function key(e){
  var el=e.target&&e.target.closest?e.target.closest(".win-info"):null;
  if(e.key==="Escape"&&open&&(!el||el===open)){
   var a=open;winInfoHide(doc,a);open=null;
   if(doc.activeElement!==a){quiet=true;a.focus();quiet=false}
  }
 }
 // capture phase: a card's own keydown handler may stopPropagation; Esc must still close
 doc.addEventListener("keydown",key,true);
 doc.addEventListener("pointerover",over);
 doc.addEventListener("pointerout",out);
 doc.addEventListener("focusin",over);
 doc.addEventListener("focusout",out);
 doc.addEventListener("click",function(e){
  var a=e.target;var el=a&&a.closest?a.closest(".win-info"):null;
  if(!el)return;
  if(el===open){winInfoHide(doc,el);open=null}
  else{winInfoShow(doc,win,el);open=el}
 });
 win.addEventListener("scroll",function(){if(open)winInfoPlace(winInfoPopup(doc),open.getBoundingClientRect(),win)});
 win.addEventListener("resize",function(){if(open)winInfoPlace(winInfoPopup(doc),open.getBoundingClientRect(),win)});
}
`;
