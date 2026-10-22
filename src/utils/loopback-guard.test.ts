import { describe, it, expect, afterAll } from "vitest";
import { request, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loopbackRefusal, isTailnetOrLocalName } from "./loopback-guard.js";
import { createProxyServer } from "../workers/proxy/server.js";
import { routerHandler } from "../router/router.js";

const fake = (headers: Record<string, string>, method = "POST", localPort = 8798) => ({ headers, method, socket: { localPort } }) as never;

describe("loopbackRefusal", () => {
  it("safe methods always pass", () => {
    expect(loopbackRefusal(fake({ host: "evil.example" }, "GET"))).toBeNull();
  });
  it("rebound Host, wrong port, foreign Origin, cross-site fetch are 403", () => {
    expect(loopbackRefusal(fake({ host: "evil.example:8798" }))?.status).toBe(403);
    expect(loopbackRefusal(fake({ host: "evil.example:8798", origin: "http://evil.example:8798" }))?.status).toBe(403);
    expect(loopbackRefusal(fake({ host: "127.0.0.1:9999" }))?.status).toBe(403);
    expect(loopbackRefusal(fake({ host: "127.0.0.1:8798", origin: "https://evil.example" }))?.status).toBe(403);
    expect(loopbackRefusal(fake({ host: "127.0.0.1:8798", origin: "null" }))?.status).toBe(403);
    expect(loopbackRefusal(fake({ host: "127.0.0.1:8798", "sec-fetch-site": "cross-site" }))?.status).toBe(403);
    expect(loopbackRefusal(fake({}))?.status).toBe(403);
  });
  it("text/plain is 415 when JSON is required", () => {
    expect(loopbackRefusal(fake({ host: "127.0.0.1:8798", "content-type": "text/plain" }), { requireJson: true })?.status).toBe(415);
    expect(loopbackRefusal(fake({ host: "127.0.0.1:8798" }), { requireJson: true })?.status).toBe(415);
  });
  it("loopback names, no Origin or same Origin, JSON pass", () => {
    const json = { "content-type": "application/json; charset=utf-8" };
    for (const host of ["127.0.0.1:8798", "localhost:8798", "[::1]:8798"]) expect(loopbackRefusal(fake({ host, ...json }), { requireJson: true })).toBeNull();
    expect(loopbackRefusal(fake({ host: "127.0.0.1:8798", origin: "http://127.0.0.1:8798", ...json }), { requireJson: true })).toBeNull();
  });
  it("router hosts: tailnet IP, MagicDNS and bare names pass; public names do not", () => {
    expect(isTailnetOrLocalName("100.101.2.3")).toBe(true);
    expect(isTailnetOrLocalName("box.tail1234.ts.net")).toBe(true);
    expect(isTailnetOrLocalName("mybox")).toBe(true);
    expect(isTailnetOrLocalName("evil.example")).toBe(false);
    expect(isTailnetOrLocalName("8.8.8.8")).toBe(false);
    expect(isTailnetOrLocalName("100.10.2.3")).toBe(false);
  });
});

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

function post(srv: Server, path: string, headers: Record<string, string>, body = "{}"): Promise<number> {
  return new Promise((resolve, reject) => {
    const port = (srv.address() as AddressInfo).port;
    const rq = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-length": Buffer.byteLength(body), ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    rq.on("error", reject);
    rq.end(body);
  });
}

async function listening(srv: Server): Promise<number> {
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return (srv.address() as AddressInfo).port;
}

describe("proxy server guard", () => {
  it("refuses cross-origin, rebound Host and text/plain; a loopback JSON POST reaches the handler", async () => {
    const srv = createProxyServer({ resolveProvider: () => ({}) });
    const port = await listening(srv);
    const json = { "content-type": "application/json" };
    const path = "/glm/v1/messages";
    expect(await post(srv, path, { ...json, origin: "https://evil.example" })).toBe(403);
    expect(await post(srv, path, { ...json, host: `evil.example:${port}` })).toBe(403);
    expect(await post(srv, path, { "content-type": "text/plain" })).toBe(415);
    // guard passed: the (empty) provider table answers 404 "no worker provider"
    expect(await post(srv, path, json)).toBe(404);
    expect(await post(srv, path, { ...json, origin: `http://127.0.0.1:${port}` })).toBe(404);
  });
});

describe("router /v1 guard", () => {
  it("refuses a rebound Host and a foreign Origin before any routing", async () => {
    const srv = createServer(routerHandler(() => ({}), undefined, () => undefined, () => undefined));
    const port = await listening(srv);
    const json = { "content-type": "application/json" };
    expect(await post(srv, "/v1/messages", { ...json, host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toBe(403);
    expect(await post(srv, "/v1/messages", { ...json, origin: "https://evil.example" })).toBe(403);
    expect(await post(srv, "/v1/messages", json)).not.toBe(403);
  });
});
