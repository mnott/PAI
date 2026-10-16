/**
 * Tests for src/router/cockpit-auth.ts: bind resolution, the /v1 remote
 * guard, and cockpit token enforcement. The integration half drives real
 * sockets from loopback; the remote-address rule itself is unit-tested on the
 * guard function (a second host is not available here).
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import {
  cockpitTokenFile,
  cockpitTokenOk,
  defaultV1Guard,
  inTailscaleRange,
  isLoopbackAddress,
  readOrCreateCockpitToken,
  resolveBindAddress,
  withCockpitToken,
} from "./cockpit-auth.js";
import { handleCockpit } from "./cockpit.js";
import { routerHandler } from "./router.js";

const ifaces = (map: Record<string, NetworkInterfaceInfo[]>) => () => map;
const v4 = (address: string): NetworkInterfaceInfo[] => [{ address, family: "IPv4", internal: false } as NetworkInterfaceInfo];

describe("resolveBindAddress", () => {
  it("defaults to loopback and never touches the interface table", () => {
    const boom = () => {
      throw new Error("must not be called");
    };
    expect(resolveBindAddress(undefined, boom)).toBe("127.0.0.1");
    expect(resolveBindAddress("", boom)).toBe("127.0.0.1");
    expect(resolveBindAddress("loopback", boom)).toBe("127.0.0.1");
    expect(resolveBindAddress("Loopback", boom)).toBe("127.0.0.1");
  });

  it("resolves tailscale to the utun address inside 100.64.0.0/10", () => {
    const up = ifaces({ en0: v4("192.168.1.10"), utun3: v4("100.64.121.56") });
    expect(resolveBindAddress("tailscale", up)).toBe("100.64.121.56");
  });

  it("falls back to any in-range address when no utun carries one", () => {
    const odd = ifaces({ en7: v4("100.64.121.56"), utun3: v4("fd7a:115c:a1e0::1") });
    expect(resolveBindAddress("tailscale", odd)).toBe("100.64.121.56");
  });

  it("returns null when tailscale is down (no in-range address)", () => {
    const down = ifaces({ en0: v4("192.168.1.10"), utun3: v4("fd7a:115c:a1e0::1") });
    expect(resolveBindAddress("tailscale", down)).toBeNull();
  });

  it("takes an explicit IPv4 as-is and refuses wildcards and junk", () => {
    const empty = ifaces({});
    expect(resolveBindAddress("100.64.121.56", empty)).toBe("100.64.121.56");
    expect(resolveBindAddress("192.168.1.10", empty)).toBe("192.168.1.10");
    expect(resolveBindAddress("0.0.0.0", empty)).toBeNull();
    expect(resolveBindAddress("::", empty)).toBeNull();
    expect(resolveBindAddress("*", empty)).toBeNull();
    expect(resolveBindAddress("junk", empty)).toBeNull();
    expect(resolveBindAddress("100.64.121.56:8790", empty)).toBeNull();
  });
});

describe("the /v1 remote rule", () => {
  it("accepts loopback in every spelling", () => {
    for (const a of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", undefined]) {
      expect(isLoopbackAddress(a), a).toBe(a !== undefined);
    }
  });

  it("knows the CGNAT /10 boundaries", () => {
    expect(inTailscaleRange("100.63.255.255")).toBe(false);
    expect(inTailscaleRange("100.64.0.0")).toBe(true);
    expect(inTailscaleRange("100.64.121.56")).toBe(true);
    expect(inTailscaleRange("100.127.255.255")).toBe(true);
    expect(inTailscaleRange("100.128.0.0")).toBe(false);
    expect(inTailscaleRange("::ffff:100.64.121.56")).toBe(true);
    expect(inTailscaleRange("192.168.1.10")).toBe(false);
    expect(inTailscaleRange("junk")).toBe(false);
    expect(inTailscaleRange(undefined)).toBe(false);
  });

  it("passes loopback and tailnet, denies LAN and undefined", () => {
    expect(defaultV1Guard("127.0.0.1")).toBe(true);
    expect(defaultV1Guard("::ffff:127.0.0.1")).toBe(true);
    expect(defaultV1Guard("100.64.121.56")).toBe(true);
    expect(defaultV1Guard("::ffff:100.64.121.56")).toBe(true);
    expect(defaultV1Guard("192.168.1.50")).toBe(false);
    expect(defaultV1Guard("10.0.0.7")).toBe(false);
    expect(defaultV1Guard(undefined)).toBe(false);
  });
});

describe("cockpit token", () => {
  it("is created 0600 on first use and reused afterwards", () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-token-"));
    const file = join(dir, "router-cockpit.token");
    const t = readOrCreateCockpitToken(file);
    expect(t).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readOrCreateCockpitToken(file)).toBe(t);
    expect(readOrCreateCockpitToken(join(dir, "other.token"))).not.toBe(t);
  });

  it("accepts ?token=, Bearer, and the cookie; nothing else", () => {
    const ok = (url: string, headers: http.IncomingHttpHeaders = {}) => cockpitTokenOk(url, headers, "sekret-token");
    expect(ok("/cockpit?token=sekret-token")).toBe(true);
    expect(ok("/cockpit?token=wrong")).toBe(false);
    expect(ok("/cockpit", { authorization: "Bearer sekret-token" })).toBe(true);
    expect(ok("/cockpit", { authorization: "Bearer wrong" })).toBe(false);
    expect(ok("/cockpit", { cookie: "other=1; pai_cockpit=sekret-token" })).toBe(true);
    expect(ok("/cockpit", { cookie: "pai_cockpit=wrong" })).toBe(false);
    expect(ok("/cockpit")).toBe(false);
    expect(ok("/cockpit", { authorization: "Basic zz" })).toBe(false);
  });

  it("derives the file from PAI_HOME", () => {
    expect(cockpitTokenFile().endsWith("router-cockpit.token")).toBe(true);
  });
});

describe("cockpit + /v1 over http", () => {
  const listen = (s: http.Server) =>
    new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
  const ask = (port: number, path: string, headers: http.OutgoingHttpHeaders = {}, method = "GET") =>
    new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve) => {
      http.request({ port, host: "127.0.0.1", path, headers, method }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: b, headers: r.headers }));
      }).end();
    });

  const limits = { get: async () => [] };

  it("serves the cockpit with a token, 401 without, and sets the cookie", async () => {
    const cockpit = withCockpitToken("sekret-token", (req, res) => handleCockpit(req, res, limits));
    const handler = routerHandler(() => ({}), "http://127.0.0.1:9/w", () => undefined, undefined, cockpit, {
      remoteAllowed: () => false, // every /v1 remote denied — proves cockpit runs before the guard
    });
    const s = http.createServer(handler);
    const port = await listen(s);
    try {
      const no = await ask(port, "/cockpit");
      expect(no.status).toBe(401);
      expect(no.body).toContain("token required");

      const yes = await ask(port, "/cockpit?token=sekret-token");
      expect(yes.status).toBe(200);
      expect(yes.headers["content-type"]).toContain("text/html");
      expect((yes.headers["set-cookie"] ?? []).join()).toContain("pai_cockpit=sekret-token");

      const data = await ask(port, "/cockpit/data", { cookie: "pai_cockpit=sekret-token" });
      expect(data.status).toBe(200);
      expect(JSON.parse(data.body)).toMatchObject({ window: "1h" });

      const still401 = await ask(port, "/cockpit/limits");
      expect(still401.status).toBe(401);
    } finally {
      s.close();
    }
  });

  it("answers 403 for /v1 remotes outside loopback+tailnet, lets loopback through", async () => {
    const cockpit = withCockpitToken("sekret-token", (req, res) => handleCockpit(req, res, limits));
    const handler = routerHandler(() => ({}), "http://127.0.0.1:9/w", () => undefined, undefined, cockpit, {
      remoteAllowed: defaultV1Guard,
    });
    const s = http.createServer(handler);
    const port = await listen(s);
    try {
      // a LAN remote is simulated by the predicate; the socket peer here is
      // loopback, so this request exercises the pass path end to end
      const pass = await ask(port, "/v1/messages", {}, "POST");
      expect(pass.status).toBe(400); // guard passed; empty body → invalid JSON
      const unknown = await ask(port, "/v1/messages", { "content-type": "application/json" }, "POST");
      expect(unknown.status).toBe(400);

      const guarded = routerHandler(() => ({}), "http://127.0.0.1:9/w", () => undefined, undefined, cockpit, {
        remoteAllowed: (a) => a === "192.168.44.44", // the LAN peer defaultV1Guard denies
      });
      const s2 = http.createServer(guarded);
      const port2 = await listen(s2);
      try {
        const deny = await ask(port2, "/v1/models");
        expect(deny.status).toBe(403);
        expect(JSON.parse(deny.body).error.message).toContain("loopback and the tailnet");
        // the cockpit still answers on the guarded handler (token-checked)
        const c = await ask(port2, "/cockpit?token=sekret-token");
        expect(c.status).toBe(200);
      } finally {
        s2.close();
      }
    } finally {
      s.close();
    }
  });
});
