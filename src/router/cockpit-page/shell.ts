/** cockpit-page — the HTML shell: document head, then the header/main markup with every section. */

import { COCKPIT_FAVICON_DATA_URI } from "./favicon.js";
import { POOL_PANEL_HTML } from "../pool-panel.js";
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

/** Closing style tag, header, main with every section, and the opening of the page script. */
export const shellBody = (L: CockpitLayout, n: Num, q: Str, hex: Str): string => String.raw`</style><style>
#legend>.lgline{gap:2px 8px;font-size:11px}#legend>.lgline span{white-space:nowrap}
</style></head><body>
<header><h1>PAI router cockpit</h1>
<div class="tabs" id="tabs"><button data-w="1h">1 hour</button><button data-w="24h">Today</button><button data-w="7d">Week</button></div>
<span id="stamp">loading...</span><button id="reset" type="button" title="reset layout" aria-label="reset layout">⟲</button><button id="theme" type="button" title="Dark mode" aria-label="Dark mode"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="ic-moon" d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/><g class="ic-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg></button></header>
<main>
<section data-section="cloud" class="card c12"><h2>Limits and local servers<span class="tip" tabindex="0" aria-label="Cloud usage windows per provider; local model servers" data-tip="Cloud usage windows per provider; local model servers">ⓘ</span></h2><h2 class="pgsub">Local</h2><div class="pgrid" id="local"></div><h2 class="pgsub">Cloud</h2><div class="pgrid" id="cloud"></div></section>
<section data-section="routing" class="card c12"><h2>Routing<span class="tip" tabindex="0" aria-label="Per delegation tier (workers.yaml tiers) the models in the order they serve: the first available one, then the fallback order. The top line shows what each tier resolves to now. A local model that is not running is skipped, not started. Read-only: edit workers.yaml or run pai worker route set." data-tip="Per delegation tier (workers.yaml tiers) the models in the order they serve: the first available one, then the fallback order. The top line shows what each tier resolves to now. A local model that is not running is skipped, not started. Read-only: edit workers.yaml or run pai worker route set.">ⓘ</span></h2><div id="routing"></div></section>
<section data-section="workers" class="card c12"><h2>Workers — running and waiting<span class="tip" id="queuetip" tabindex="0" aria-label="Provider capacity queue" data-tip="Provider capacity queue">ⓘ</span></h2><div id="queuepanel"></div></section>
${POOL_PANEL_HTML}
<section data-section="models" class="card c12"><h2>Models — runtimes<span class="tip" id="modelstip" tabindex="0" aria-label="Models" data-tip="Models">ⓘ</span><button type="button" class="fold" id="minall" hidden></button></h2><div id="modelspanel"></div></section>
<section data-section="system" class="card c12"><h2>System — memory, load, temperature, power</h2><div id="sys" style="container-type:inline-size"></div><div id="syshid"></div><h2 style="margin-top:8px">Power and GPU/CPU load<span class="tip" tabindex="0" aria-label="Same buckets as the window selected above. W on the left axis, load % on the fixed 0-100 right axis." data-tip="Same buckets as the window selected above. W on the left axis, load % on the fixed 0-100 right axis.">ⓘ</span></h2><div id="power"></div><div class="legend" id="plegend"></div><div id="sysservers" style="margin-top:8px;container-type:inline-size"></div></section>
<section data-section="memory" class="card c12"><h2>${L.memoryTitle.replace(/[<>&"]/g, "")}<span class="tip" id="memorytip" tabindex="0" aria-label="Memory index" data-tip="Memory index">ⓘ</span> <span id="memrun" style="margin-left:8px;font-size:12px"></span></h2><div id="memorypanel" style="container-type:inline-size"></div></section>
<section data-section="kpis" class="card c12"><h2>Totals in this window<span class="tip" tabindex="0" aria-label="Requests, tokens and errors over the selected window (1 hour / Today / Week)." data-tip="Requests, tokens and errors over the selected window (1 hour / Today / Week).">ⓘ</span></h2><div class="kpis" id="kpis"></div></section>
<section data-section="tokens" class="card c8"><h2>Tokens per bucket by kind<span class="tip" id="wnote" tabindex="0" aria-label="Token counts" data-tip="Token counts">ⓘ</span></h2><div class="ctl"><span id="mode"><button data-m="weighted">weighted</button><button data-m="raw">raw</button></span><select id="msel"></select></div><div id="series"></div><div id="seriescap"></div><div class="legend" id="legend"></div></section>
<section data-section="cache" class="card c4"><h2>Cache hit ratio<span class="tip" tabindex="0" aria-label="cache_read / (read + write + fresh input), per provider / model." data-tip="cache_read / (read + write + fresh input), per provider / model.">ⓘ</span></h2><div id="donut" class="rings"></div><div id="donutlow" class="chips lowmodels"></div><div id="donutnote" class="chips"></div>
<h2 id="donutlocaltitle" style="margin-top:8px;display:none">Local prefix cache<span class="tip" tabindex="0" aria-label="Server counters cover the time since that server started; router log rows only since the router restarted, so the two windows differ. A hit skips re-computing the cached prompt part (latency), not money." data-tip="Server counters cover the time since that server started; router log rows only since the router restarted, so the two windows differ. A hit skips re-computing the cached prompt part (latency), not money.">ⓘ</span></h2><div id="donutlocal"></div>
<h2 style="margin-top:8px">Providers<span class="tip" tabindex="0" aria-label="* server counter (prefix cache since server start; this provider reports no cache fields per request). avg ms is end-to-end incl. queueing and prefill, ttft p50 is time to first token." data-tip="* server counter (prefix cache since server start; this provider reports no cache fields per request). avg ms is end-to-end incl. queueing and prefill, ttft p50 is time to first token.">ⓘ</span></h2><div id="providers"></div></section>
<section data-section="speed" class="card c12"><h2>Speed per model<span class="tip" tabindex="0" aria-label="TTFT = request sent to first content token. Read = input tokens / TTFT (prefill incl. cached for local models; for Anthropic input excludes cache reads). Write = output tokens / decode time, replies of 16+ tokens only. Medians (p50) unless marked." data-tip="TTFT = request sent to first content token. Read = input tokens / TTFT (prefill incl. cached for local models; for Anthropic input excludes cache reads). Write = output tokens / decode time, replies of 16+ tokens only. Medians (p50) unless marked.">ⓘ</span></h2><div id="speed"></div></section>
<section data-section="pause" class="card c12"><h2>Cache verdict by pause<span class="tip" tabindex="0" aria-label="Per model. Pause = time since the previous request of the same session. A drop in hits after 5m means the cache expired between turns: a keepalive under 5m would have kept it." data-tip="Per model. Pause = time since the previous request of the same session. A drop in hits after 5m means the cache expired between turns: a keepalive under 5m would have kept it.">ⓘ</span></h2><div id="pause"></div></section>
<section data-section="sessions" class="card c12"><h2>Sessions by tokens</h2><div id="sessions"></div></section>
<section data-section="runs" class="card c6"><h2>Worker runs</h2><div id="workers"></div></section>
<section data-section="daily" class="card c6"><h2>Tokens per day per model (${L.dailyDays} d)</h2><div id="daily"></div><div id="dailycap"></div><div class="legend" id="dlegend"></div></section>
</main>
<script>
(function(){
`;
