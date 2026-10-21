import { describe, expect, it } from "vitest";
import { LOOPBACK_HOST, isLoopbackHostname, isLoopbackUrl, loopbackUrl } from "./loopback.js";
import { LOCAL_PROBE_TIMEOUT_MS } from "./timeouts.js";

describe("loopback", () => {
  it("names this machine in every URL form", () => {
    for (const u of ["http://127.0.0.1:1/", "http://localhost/", "http://[::1]:2/x"]) expect(isLoopbackUrl(u)).toBe(true);
    for (const u of ["http://10.0.0.5/", "https://api.example.com", "not a url"]) expect(isLoopbackUrl(u)).toBe(false);
    expect(isLoopbackHostname("::1")).toBe(true);
  });
  it("builds loopback URLs", () => {
    expect(loopbackUrl(8790)).toBe(`http://${LOOPBACK_HOST}:8790`);
    expect(loopbackUrl(8016, "/v1/models")).toBe("http://127.0.0.1:8016/v1/models");
  });
  it("probe timeout is one value", () => {
    expect(LOCAL_PROBE_TIMEOUT_MS).toBe(2000);
  });
});
