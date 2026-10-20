import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeAnthropicModels } from "../../workers/config.js";
import { CliError } from "../define.js";
import { renameSession } from "../lib/names.js";
import { planOpen } from "./session.js";

const mk = (enabled = true) => ({ enabled, protocol: "anthropic" as const, baseUrl: "https://x.invalid", keyFile: null, env: {}, models: { default: "m" } });
const workers = {
  active: "glm",
  nativeModels: { ...nativeAnthropicModels() },
  providers: { glm: mk(), kimi: mk(), off: mk(false) },
};

describe("planOpen: pai open NAME --provider X", () => {
  const origin = { provider: "glm", model: "m" };
  it("explicit --provider wins over the session's provider and the active one", () => {
    expect(planOpen({ workers, origin, flagProvider: "kimi", name: "n" }).provider).toBe("kimi");
  });
  it("without a flag it reopens on the session's own provider, not the active one", () => {
    expect(planOpen({ workers: { ...workers, active: "kimi" }, origin, name: "n" }).provider).toBe("glm");
  });
  it("an unavailable --provider fails, never falls back, and names what works", () => {
    for (const bad of ["off", "missing"]) {
      try {
        planOpen({ workers, origin, flagProvider: bad, name: "n" });
        throw new Error("expected failure");
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        expect((e as CliError).message).toContain("anthropic, glm, kimi");
        expect((e as CliError).hint).toContain('pai open "n" --provider');
      }
    }
  });
});

describe("renameSession", () => {
  it("renames an existing entry and adds a missing one, in a temp registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-names-"));
    const path = join(dir, "session.json");
    writeFileSync(path, JSON.stringify({ sessions: [{ name: "old", resume: "u1", directory: "/d" }], keep: 1 }));
    expect(renameSession("u1", "new", undefined, path).previous).toBe("old");
    renameSession("u2", "other", "/e", path);
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.keep).toBe(1);
    expect(data.sessions).toEqual([
      { name: "new", resume: "u1", directory: "/d" },
      { name: "other", resume: "u2", directory: "/e" },
    ]);
  });
});
