import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createToken, revokeToken } from "./auth.js";
import { CAPABILITY_KEYS } from "./discovery.js";
import { createUhpServer } from "./server.js";
import { defaultWorkersConfig } from "../workers/config.js";

let dir: string;
let base: string;
let closeServer: () => void;
let token: string;
let revoked: string;
let scoped: string;

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uhp-contract-"));
  const tokensPath = join(dir, "tokens.json");
  token = createToken(tokensPath, "open").token;
  const r = createToken(tokensPath, "gone");
  revoked = r.token;
  revokeToken(tokensPath, r.record.id);
  scoped = createToken(tokensPath, "scoped", ["chrn_none"]).token;
  const server = createUhpServer({ tokensPath, loadWorkers: defaultWorkersConfig, probe: async () => true });
  await new Promise<void>((r2) => server.listen(0, "127.0.0.1", r2));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => server.close();
});

afterAll(() => {
  closeServer();
  rmSync(dir, { recursive: true, force: true });
});

describe("UHP wire contract (2026-10-19)", () => {
  it("serves discovery unauthenticated with all 14 capability keys", async () => {
    const res = await get("/v1/uhp");
    expect(res.status).toBe(200);
    expect(res.headers.get("uhp-version")).toBe("2026-10-19");
    const d = await res.json();
    expect(d).toMatchObject({ object: "uhp.discovery", protocol: "uhp", versions: ["2026-10-19"], default_version: "2026-10-19" });
    expect(Object.keys(d.capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());
    expect(CAPABILITY_KEYS).toHaveLength(14);
  });

  it("answers 401 missing_credential, then invalid_credential for unknown and revoked alike", async () => {
    const none = await get("/v1/harnesses");
    expect(none.status).toBe(401);
    expect((await none.json()).error).toMatchObject({ type: "authentication_error", code: "missing_credential" });
    const unknown = await (await get("/v1/harnesses", { authorization: "Bearer nope" })).json();
    const gone = await (await get("/v1/harnesses", { authorization: `Bearer ${revoked}` })).json();
    expect(unknown.error.code).toBe("invalid_credential");
    expect(gone).toEqual(unknown);
  });

  it("uses the error envelope and the version header on 404 and on unsupported versions", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const nf = await get("/v1/harnesses/chrn_missing", auth);
    expect(nf.status).toBe(404);
    expect(nf.headers.get("uhp-version")).toBe("2026-10-19");
    expect(await nf.json()).toEqual({ error: { type: "invalid_request_error", code: "harness_not_found", message: expect.any(String), param: "harness_id", detail: null } });
    const bad = await get("/v1/uhp", { "uhp-version": "1999-01-01" });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("uhp-version")).toBe("2026-10-19");
    expect((await bad.json()).error).toMatchObject({ code: "unsupported_protocol_version", detail: { supported: ["2026-10-19"] } });
  });

  it("lists harnesses and models for a valid token and hides objects outside a token's scope", async () => {
    const list = await (await get("/v1/harnesses", { authorization: `Bearer ${token}` })).json();
    expect(list.harnesses.length).toBeGreaterThan(0);
    const h = list.harnesses[0];
    expect(h).toMatchObject({ object: "harness", baseLabel: "PAI worker" });
    expect(h.id).toMatch(/^chrn_/);
    const models = await (await get(`/v1/harnesses/${h.id}/models`, { authorization: `Bearer ${token}` })).json();
    expect(models).toMatchObject({ harness_id: h.id, default: h.defaultModel, fallback: h.defaultModel });
    const cat = await (await get("/v1/models", { authorization: `Bearer ${token}` })).json();
    expect(typeof Object.values<{ models: { available: unknown }[] }>(cat.backends)[0].models[0].available).toBe("boolean");
    const out = await get(`/v1/harnesses/${h.id}`, { authorization: `Bearer ${scoped}` });
    expect(out.status).toBe(404);
  });
});
