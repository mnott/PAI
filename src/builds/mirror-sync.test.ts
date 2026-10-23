import { describe, expect, it } from "vitest";
import {
  deriveForge,
  formatMirror,
  parseMirrorError,
  parseMirrors,
  syncMirrors,
  forgeTokenEnvName,
  shippedForgeTokenEnvName,
  MirrorSyncFailed,
  type FetchLike,
} from "./mirror-sync.js";

const ok = (text: string) => ({ status: 200, text });

/** GET push_mirrors -> `before`, POST push_mirrors-sync -> 200, GET -> `after`. */
function scripted(before: unknown, after: unknown): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === "POST") return ok("");
      return ok(JSON.stringify(n++ === 0 ? before : after));
    },
  };
}

const mirror = (name: string, lastUpdate: string, sha: string, lastError?: string) => ({
  name,
  last_update: lastUpdate,
  commit_sha: sha,
  ...(lastError ? { last_error: lastError } : {}),
});

const run = async (s: { fetch: FetchLike }) =>
  syncMirrors(".", { fetch: s.fetch, token: "t", originUrl: "https://forge.example/git/acme/app.git", now: () => 0, sleep: async () => {} });

describe("forge origin derivation", () => {
  it("https url with a path prefix", () => {
    expect(deriveForge("https://forge.example/git/acme/app.git")).toEqual({ baseUrl: "https://forge.example/git", repo: "acme/app" });
  });
  it("https url without prefix or .git", () => {
    expect(deriveForge("https://forge.example/acme/app")).toEqual({ baseUrl: "https://forge.example", repo: "acme/app" });
  });
  it("ssh scp form", () => {
    expect(deriveForge("git@forge.example:acme/app.git")).toEqual({ baseUrl: "https://forge.example", repo: "acme/app" });
  });
  it("ssh form with a path prefix", () => {
    expect(deriveForge("ssh://git@forge.example/git/acme/app.git")).toEqual({ baseUrl: "https://forge.example/git", repo: "acme/app" });
  });
  it("a bare host is not a repo", () => {
    expect(() => deriveForge("https://forge.example")).toThrow(MirrorSyncFailed);
  });
});

describe("mirror sync", () => {
  it("ok case: the mirror's last_update changed, exit line names the sha", async () => {
    const s = scripted(
      [mirror("github", "2026-10-22T20:00:00Z", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
      [mirror("github", "2026-10-23T01:00:00Z", "b7f3c9d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6")]
    );
    const r = await run(s);
    expect(r.repo).toBe("acme/app");
    expect(r.mirrors).toEqual([{ name: "github", ok: true, commitSha: "b7f3c9d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6" }]);
    expect(formatMirror(r.mirrors[0]!)).toBe("github: ok (github at b7f3c9d2)");
    expect(s.calls).toEqual([
      "GET https://forge.example/git/api/v1/repos/acme/app/push_mirrors",
      "POST https://forge.example/git/api/v1/repos/acme/app/push_mirrors-sync",
      "GET https://forge.example/git/api/v1/repos/acme/app/push_mirrors",
    ]);
  });

  it("GH013 push protection: short reason and the unblock URL", async () => {
    const lastError =
      '---\nremote: error: GH013: Repository rule validation failed for push-mirror-1\nremote: GitHub found 1 secret on the push: "AWS Access Key ID". To unblock this push, visit https://github.com/acme/app/unblock-secret/01ABCDEF23456789ABCDEF0123456789ABCD\nremote: rejected main -> main "GH013"\n---';
    const s = scripted(
      [mirror("github", "2026-10-22T20:00:00Z", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
      [mirror("github", "2026-10-23T01:00:00Z", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", lastError)]
    );
    const r = await run(s);
    expect(r.mirrors[0]!.ok).toBe(false);
    expect(r.mirrors[0]!.error?.reason).toBe("push protection");
    expect(formatMirror(r.mirrors[0]!)).toBe(
      'github: REJECTED — push protection: secret detection found 1 secret on the push: "AWS Access Key ID"; unblock: https://github.com/acme/app/unblock-secret/01ABCDEF23456789ABCDEF0123456789ABCD'
    );
  });

  it("a plain remote rejection gets its reason", async () => {
    const s = scripted(
      [mirror("github", "2026-10-22T20:00:00Z", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
      [mirror("github", "2026-10-23T01:00:00Z", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 'remote rejected main -> main (fetch first)\n')]
    );
    const r = await run(s);
    expect(r.mirrors[0]!.error).toEqual({ reason: "remote rejected", detail: "main -> main (fetch first)" });
  });

  it("an unchanged last_update within the window is not ok", async () => {
    const same = [mirror("github", "2026-10-22T20:00:00Z", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")];
    const r = await run(scripted(same, same));
    expect(r.mirrors[0]!.ok).toBe(false);
    expect(r.mirrors[0]!.error?.reason).toBe("not synced");
  });

  it("a network error surfaces as an error, not a rejected mirror", async () => {
    const s = scripted([], []);
    const fetch: FetchLike = async (url, init) => {
      if (init.method === "POST") throw new Error("connect ECONNREFUSED");
      return s.fetch(url, init);
    };
    await expect(syncMirrors(".", { fetch, token: "t", originUrl: "https://forge.example/acme/app.git" })).rejects.toThrow("ECONNREFUSED");
  });

  it("no token is an error naming the env var, without printing any token", async () => {
    const saved = process.env.AIBROKER_FORGE_TOKEN;
    delete process.env.AIBROKER_FORGE_TOKEN;
    try {
      await expect(
        syncMirrors(".", { fetch: scripted([], []).fetch, originUrl: "https://forge.example/acme/app.git", readConfig: () => ({}) })
      ).rejects.toThrow("AIBROKER_FORGE_TOKEN");
    } finally {
      if (saved !== undefined) process.env.AIBROKER_FORGE_TOKEN = saved;
    }
  });

  it("config release.forgeTokenEnv names the env var; the default is AIBROKER_FORGE_TOKEN", () => {
    expect(forgeTokenEnvName(() => ({ release: { forgeTokenEnv: "MY_FORGE_TOKEN" } }))).toBe("MY_FORGE_TOKEN");
    expect(forgeTokenEnvName(() => ({}))).toBe("AIBROKER_FORGE_TOKEN");
    expect(shippedForgeTokenEnvName()).toBe("AIBROKER_FORGE_TOKEN");
  });

  it("a sync POST that fails is an error", async () => {
    const fetch: FetchLike = async (_url, init) => (init.method === "POST" ? { status: 403, text: "{}" } : ok("[]"));
    await expect(syncMirrors(".", { fetch, token: "t", originUrl: "https://forge.example/acme/app.git" })).rejects.toThrow("HTTP 403");
  });
});

describe("last_error parsing", () => {
  it("other errors are the first 200 chars", () => {
    const e = parseMirrorError("x".repeat(300));
    expect(e.reason).toHaveLength(200);
  });
  it("a non-list body parses to no mirrors", () => {
    expect(parseMirrors('{"message":"not found"}')).toEqual([]);
  });
});
