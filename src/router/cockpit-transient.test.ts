/** The transient marker of the cockpit payloads: set on a failure that may pass, absent on a clean answer. */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handleCockpit } from "./cockpit.js";
import type { ProviderLimits } from "./limits.js";

let srv: http.Server | null = null;
afterEach(() => { srv?.close(); srv = null; });

async function get(limits: { get: () => Promise<ProviderLimits[]> }, path: string): Promise<{ status: number; json: any }> {
  const system = { snapshot: async () => ({ at: 1 }) } as never;
  srv = http.createServer((req, res) => { if (!handleCockpit(req, res, limits as never, () => [], () => new Map(), system)) res.end("other"); });
  await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return new Promise((resolve) => http.get({ host: "127.0.0.1", port, path }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(b) }));
  }));
}

const plan = (extra: Partial<ProviderLimits> = {}): ProviderLimits => ({ provider: "anthropic", kind: "plan", windows: [], fetchedAt: 1, ...extra });

describe("transient payload marker", () => {
  it("/cockpit/limits carries the cause of a failed provider poll, and nothing on a clean answer", async () => {
    const clean = await get({ get: async () => [plan()] }, "/cockpit/limits");
    expect(clean.status).toBe(200);
    expect(clean.json.transient).toBeUndefined();
    const failed = await get({ get: async () => [plan({ error: "http 500" })] }, "/cockpit/limits");
    expect(failed.json.transient).toBe("anthropic: http 500");
    expect(failed.json.limits).toHaveLength(1);
  });

  it("/cockpit/system is transient when the limits source failed, not otherwise", async () => {
    const ok = await get({ get: async () => [] }, "/cockpit/system");
    expect(ok.json.transient).toBeUndefined();
    const down = await get({ get: async () => { throw new Error("x"); } }, "/cockpit/system");
    expect(down.status).toBe(200);
    expect(down.json.transient).toBe("limits unavailable");
  });
});
