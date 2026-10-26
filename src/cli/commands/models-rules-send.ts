/** The provider call behind `pai models rules probe`: one non-streaming Messages API request straight to the provider (not through the router, so nothing repairs the answer). */

import { readWorkersSection, resolveProviderKey } from "../../workers/config.js";
import type { ProbeAnswer } from "../../router/tool-call-rules-ops.js";

export function providerSend(name: string): (body: Record<string, unknown>) => Promise<ProbeAnswer> {
  const p = readWorkersSection().workers.providers[name];
  if (!p) throw new Error(`no provider named ${name} (see: pai providers)`);
  const key = resolveProviderKey(p) ?? "local";
  const url = `${p.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  return async (body) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${key}`, "x-api-key": key },
      body: JSON.stringify({ model: p.models.default, stream: false, ...body }),
      signal: AbortSignal.timeout(300_000),
    });
    let json: ProbeAnswer["body"] = {};
    try {
      json = (await r.json()) as ProbeAnswer["body"];
    } catch {
      /* non-JSON body */
    }
    return { status: r.status, body: json };
  };
}
