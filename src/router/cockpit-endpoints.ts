/**
 * cockpit-endpoints.ts — the cockpit's view of the endpoint registry: which
 * endpoints exist (managed instances and registered providers, enabled or
 * not) and which selectors a routing row can take. Pure; the payload builder
 * passes the live inputs.
 */

import { routeChoices } from "../workers/route-table.js";
import type { WorkersConfig } from "../workers/config.js";
import type { LocalInstance } from "../workers/local-instances.js";

export interface EndpointRow {
  id: string;
  model: string;
  provider: string;
  origin: "managed" | "registered";
  /** host:port the requests go to */
  host: string;
  /** probe answer (registered) or state === ready (managed) */
  healthy: boolean;
  /** managed instances are always routable; a registered one follows its provider's `enabled` */
  enabled: boolean;
  tags: string[];
  classes: string[];
}

const hostOf = (url: string): string => {
  return URL.canParse(url) ? new URL(url).host : url;
};

/** Managed instances first, then every provider that declares characteristics (disabled ones too, so they can be switched back on). */
export function endpointRows(workers: WorkersConfig, managed: LocalInstance[], healthy: (i: LocalInstance) => boolean): EndpointRow[] {
  const out: EndpointRow[] = managed.map((i) => ({
    id: i.id, model: i.model, provider: i.provider, origin: "managed", host: hostOf(i.url),
    healthy: i.state === "ready" && healthy(i), enabled: true, tags: i.characteristics?.tags ?? [], classes: i.characteristics?.classes ?? [],
  }));
  const ids = new Set(managed.map((i) => i.id));
  for (const [name, p] of Object.entries(workers.providers)) {
    if (!p.characteristics || ids.has(name)) continue;
    const inst: LocalInstance = { id: name, model: name, provider: name, url: p.baseUrl, origin: "registered", port: 0, state: "ready", startedAt: 0, log: "", characteristics: p.characteristics };
    out.push({
      id: name, model: name, provider: name, origin: "registered", host: hostOf(p.baseUrl),
      healthy: p.enabled !== false && healthy(inst), enabled: p.enabled !== false,
      tags: p.characteristics.tags ?? [], classes: p.characteristics.classes ?? [],
    });
  }
  return out;
}

/** What a routing row can name: the `local` selector, model/tag/class selectors from the enabled endpoints, then the provider entries. */
export function selectorChoices(workers: WorkersConfig, endpoints: EndpointRow[]): { entry: string; label: string }[] {
  const live = endpoints.filter((e) => e.enabled);
  const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();
  return [
    { entry: "local", label: "local (any healthy local endpoint)" },
    ...uniq(live.map((e) => e.model)).map((m) => ({ entry: `model:${m}`, label: `model:${m}` })),
    ...uniq(live.flatMap((e) => e.tags)).map((t) => ({ entry: `tag:${t}`, label: `tag:${t}` })),
    ...uniq(live.flatMap((e) => e.classes)).map((c) => ({ entry: `class:${c}`, label: `class:${c}` })),
    ...routeChoices(workers).map((c) => ({ entry: c.entry, label: c.label })),
  ];
}
