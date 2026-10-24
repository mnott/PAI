import { describe, expect, it } from "vitest";
import { paiConfigFilePath } from "../daemon/config.js";
import { fakeUrl } from "../utils/fake-secret.js";
import { createPgPool } from "./pg-pool.js";

describe("test isolation from the live database and config", () => {
  it("refuses a connection to the live database name", () => {
    const live = process.env.PAI_TEST_LIVE_DB;
    if (!live) return; // no live config on this machine: nothing to protect
    expect(() => createPgPool({ connectionString: fakeUrl("postgresql", "u", "p", `localhost:5432/${live}`) })).toThrow(
      "test tried to open the live database",
    );
  });

  it("allows a scratch database (pool is lazy, nothing connects)", async () => {
    const pool = createPgPool({ connectionString: fakeUrl("postgresql", "u", "p", "localhost:5432/pai_test_scratch_x") });
    await pool.end();
  });

  it("reads config from the sandbox, never the real home", () => {
    expect(paiConfigFilePath().startsWith(process.env.HOME!)).toBe(true);
    expect(process.env.PAI_CONFIG_FILE!.includes("pai-test-home-")).toBe(true);
  });
});
