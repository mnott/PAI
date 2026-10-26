import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupForgeToken, resolveForgeToken } from "./forge-token.js";
import { syncMirrors } from "./mirror-sync.js";
import type { FetchLike } from "./mirror-sync.js";

const SENTINEL = "SENTINEL-tok-9f3a1c";
const NAME = "AIBROKER_FORGE_TOKEN";

describe("forge token lookup", () => {
  let home: string;
  let file: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pai-forge-token-"));
    mkdirSync(join(home, ".aibroker"));
    file = join(home, ".aibroker", "env");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const put = (text: string, mode = 0o600): void => {
    writeFileSync(file, text);
    chmodSync(file, mode);
  };

  it("env var wins over the file", () => {
    put(`${NAME}=from-file\n`);
    expect(resolveForgeToken(NAME, { env: { [NAME]: "from-env" }, home })).toBe("from-env");
    expect(resolveForgeToken(NAME, { env: { FORGE_TOKEN: "generic" }, home })).toBe("generic");
  });

  it("uses the file when the env is empty, and reports its path", () => {
    put(`# comment\n\nOTHER=x\n${NAME}=${SENTINEL}\n`);
    expect(lookupForgeToken(NAME, { env: { [NAME]: "" }, home })).toEqual({ token: SENTINEL, from: file });
  });

  it("parses export and quoted forms", () => {
    put(`export ${NAME}="${SENTINEL}"\n`);
    expect(resolveForgeToken(NAME, { env: {}, home })).toBe(SENTINEL);
    put(`export ${NAME}='${SENTINEL}'\n`);
    expect(resolveForgeToken(NAME, { env: {}, home })).toBe(SENTINEL);
    put(`#${NAME}=commented\n`);
    expect(resolveForgeToken(NAME, { env: {}, home })).toBeUndefined();
  });

  it("falls back to the AIBROKER_FORGE_TOKEN alias for a custom name", () => {
    put(`${NAME}=${SENTINEL}\n`);
    expect(resolveForgeToken("MY_TOKEN", { env: {}, home })).toBe(SENTINEL);
  });

  it("honours AIBROKER_ENV_FILE", () => {
    const other = join(home, "other-env");
    writeFileSync(other, `${NAME}=${SENTINEL}\n`, { mode: 0o600 });
    expect(resolveForgeToken(NAME, { env: { AIBROKER_ENV_FILE: other }, home })).toBe(SENTINEL);
  });

  it("ignores a group-readable file and flags it", () => {
    put(`${NAME}=${SENTINEL}\n`, 0o640);
    expect(lookupForgeToken(NAME, { env: {}, home })).toEqual({ permissionsIgnored: true });
  });

  it("a missing file yields nothing", () => {
    expect(lookupForgeToken(NAME, { env: {}, home: join(home, "nope") })).toEqual({});
  });

  const fetchNever: FetchLike = async () => ({ status: 200, text: "[]" });
  const base = { fetch: fetchNever, originUrl: "https://forge.example/acme/app.git", readConfig: () => ({}) };

  it("mirror sync: permission hint in the error, value never in it", async () => {
    put(`${NAME}=${SENTINEL}\n`, 0o644);
    const err = await syncMirrors(".", { ...base, tokenOpts: { env: {}, home } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("token file ignored: permissions");
    expect((err as Error).message).not.toContain(SENTINEL);
  });

  it("mirror sync: token from the file is reported by path only", async () => {
    put(`${NAME}=${SENTINEL}\n`);
    const r = await syncMirrors(".", { ...base, tokenOpts: { env: {}, home }, now: (() => { let t = 0; return () => (t += 61000); })(), sleep: async () => {} });
    expect(r.tokenFrom).toBe(file);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
});
