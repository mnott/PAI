# Cockpit page source layout

The cockpit is one HTML page with inline CSS and an inline script, built once per page load by `buildHtml(L)` in `src/router/cockpit-page.ts` from a layout object `L` (`src/router/cockpit-layout.ts`, values from `router.cockpit.layout` in the shipped defaults and your config). The page source is split by area so a change touches one small file:

| File | What it holds |
|---|---|
| `src/router/cockpit-page.ts` | `buildHtml`, the exported `cockpitHtml(sections?)`, `COCKPIT_HTML`, `COCKPIT_SECTION_IDS`; concatenates the parts below in order |
| `cockpit-page/shell.ts` | document head, theme bootstrap, the header and the `<section data-section="…">` markup of every section |
| `cockpit-page/css.ts` | the whole stylesheet |
| `cockpit-page/script-core.ts` | colours (model palette, `assignColors`), `setHtml` (no-jump redraw), formatters, folds, layout rows and drag and drop |
| `cockpit-page/script-models.ts` | limits gauges, the local server tile (up/down and `downReason`), the Routing section, the Models cards (aliases, start/stop, local switch, confirms) |
| `cockpit-page/script-charts.ts` | system data (metric tiles with sparklines, server tiles, the power chart) and the line, bar and legend charts |
| `cockpit-page/script-tables.ts` | donuts and rings, provider tiles (fill their row), `table()` (no horizontal scroll; stacks into cards, class `.tw.stacked`, only when a measurement says it does not fit), sessions/runs (worker runs: label / verdict word / tokens), render and load |
| `cockpit-page/script-boot.ts` | pool panel (provider-neutral, off reason from `src/router/pool-panel.ts`), queue, theme toggle, startup wiring and the polls |
| `cockpit-page/favicon.ts`, `types.ts` | favicon data URI; helper types for baked values |

Rules that keep it working:

- Every tunable number, palette or threshold comes from `L` (baked into the page with the `n()`/`q()`/`hex()` helpers that validate it); none is written as a literal in the page parts. Add a new value to `cockpit-layout.ts`, the shipped defaults (`router.cockpit.layout`) and `docs/config-defaults.md` together.
- Panels are redrawn only through `setHtml(el, html)`; a section's own id is `sec-<name>`, its inner panel keeps the plain id.
- SVG charts draw at the container's real pixel width: `chartW(el, fallback)` measures `clientWidth` and the viewBox uses it directly (height fixed), so chart text renders at its CSS font-size whatever the chart width; `*ChartWidthPx` is only the fallback when the container cannot be measured. A ResizeObserver on `main` (debounced, `chartResizeSlackPx`/`chartResizeDebounceMs`) redraws a chart when its container's pixel width changed.
- Draggable tiles carry `data-tid`, rendered by the real renderer (tests must use the real render functions, not hand-made fixtures).
- A refactor of these files must leave `cockpitHtml()` byte-identical unless the change is meant to alter the page: compare the sha256 before and after.
- Tests: `src/router/cockpit-page.test.ts` and `src/router/cockpit.test.ts`.
