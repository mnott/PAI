/** cockpit-page — the HTML shell: document head, then the header and the window root the cards are drawn into. */

import { COCKPIT_FAVICON_DATA_URI } from "./favicon.js";
import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** Doctype, head, theme bootstrap script and the opening style tag. */
export const shellHead = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PAI Cockpit</title>
<link rel="icon" type="image/svg+xml" href="${COCKPIT_FAVICON_DATA_URI}">
<meta name="theme-color" content="#3b6fe0">
<meta name="cockpit-build" content="__COCKPIT_BUILD__">
<script>
// the theme before the first paint: the saved choice, else the system's
try{var T=localStorage.getItem("pai.cockpit.theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=T}catch(e){}
try{if(localStorage.getItem("pai.cockpit.lock")==="1")document.documentElement.classList.add("locked")}catch(e){}
// the layout this install starts a device from (the router fills it in); null = the page composes its own
window.PAI_LAYOUT_DEFAULT=null/*__COCKPIT_LAYOUT__*/;
window.PAI_LAYOUT_SAVED_AT=0/*__COCKPIT_LAYOUT_SAVED_AT__*/;
</script>
<style>
`;

/** Closing style tag, header, the window root, and the opening of the page script. */
export const shellBody = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`</style><style>
#legend>.lgline{gap:2px 8px;font-size:11px}#legend>.lgline span{white-space:nowrap}
</style></head><body>
<header><h1>PAI<span class="hc"> Cockpit</span></h1><span id="ver" title="PAI __COCKPIT_VERSION__ · build __COCKPIT_BUILD__">v__COCKPIT_VERSION__</span>
<div class="tabs" id="tabs"><button data-w="1h">1 hour</button><button data-w="24h">Today</button><button data-w="7d">Week</button></div>
<a id="newer" href="#" hidden title="The router now serves a newer cockpit build than this open page; reload to get it.">newer cockpit available — reload</a><a id="newdef" href="#" hidden title="A newer default layout was saved on another device; your layout here was edited after it.">newer default available · use it</a><span id="stamp">loading...</span><span id="ask" hidden><span class="aq"></span> <button id="askyes" type="button" aria-label="confirm">✓</button><button id="askno" type="button" aria-label="cancel">✕</button></span><button id="reset" type="button" title="reset to the default layout" aria-label="reset to the default layout">⟲</button><button id="savedef" type="button" title="save this layout as the default for all devices" aria-label="save layout as default">☆</button><button id="lock" type="button" title="lock layout" aria-label="layout unlocked" aria-pressed="false"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0"/></svg></button><button id="theme" type="button" title="Dark mode" aria-label="Dark mode"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="ic-moon" d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/><g class="ic-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg></button></header>
<div id="toast" role="status" hidden></div>
<main id="win-root"></main>
<script>
(function(){
`;
