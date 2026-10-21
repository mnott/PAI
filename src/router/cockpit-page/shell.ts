/** cockpit-page — the HTML shell: document head, then the header and the window root the cards are drawn into. */

import { COCKPIT_FAVICON_DATA_URI } from "./favicon.js";
import type { CockpitLayout } from "../cockpit-layout.js";
import type { Num, Str } from "./types.js";

/** Doctype, head, theme bootstrap script and the opening style tag. */
export const shellHead = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PAI router cockpit</title>
<link rel="icon" type="image/svg+xml" href="${COCKPIT_FAVICON_DATA_URI}">
<meta name="theme-color" content="#3b6fe0">
<script>
// the theme before the first paint: the saved choice, else the system's
try{var T=localStorage.getItem("pai.cockpit.theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=T}catch(e){}
</script>
<style>
`;

/** Closing style tag, header, the window root, and the opening of the page script. */
export const shellBody = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`</style><style>
#legend>.lgline{gap:2px 8px;font-size:11px}#legend>.lgline span{white-space:nowrap}
</style></head><body>
<header><h1>PAI router cockpit</h1>
<div class="tabs" id="tabs"><button data-w="1h">1 hour</button><button data-w="24h">Today</button><button data-w="7d">Week</button></div>
<span id="stamp">loading...</span><button id="reset" type="button" title="reset layout" aria-label="reset layout">⟲</button><button id="theme" type="button" title="Dark mode" aria-label="Dark mode"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="ic-moon" d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/><g class="ic-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg></button></header>
<main id="win-root"></main>
<script>
(function(){
`;
