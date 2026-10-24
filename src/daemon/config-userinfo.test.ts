/**
 * loadConfig() under launchd: a service has no USER/LOGNAME, so os.userInfo()
 * throws ERR_SYSTEM_ERROR (uv_os_get_passwd ENOENT) — the successor router
 * crashed at startup exactly here. The per-user Postgres name must fall back
 * (loginUsername) instead of throwing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:os", async (orig) => {
  const os = await orig<typeof import("node:os")>();
  return {
    ...os,
    userInfo: () => {
      throw Object.assign(new Error("uv_os_get_passwd ENOENT"), { code: "ERR_SYSTEM_ERROR" });
    },
  };
});

const dirs: string[] = [];
const saved = { HOME: process.env.HOME, PAI_HOME: process.env.PAI_HOME, PAI_CONFIG_FILE: process.env.PAI_CONFIG_FILE };

let loadConfig: typeof import("./config.js")["loadConfig"];

beforeAll(async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "pai-config-userinfo-"));
  dirs.push(homeDir);
  const paiHome = mkdtempSync(join(tmpdir(), "pai-config-userinfo-home-"));
  dirs.push(paiHome);
  process.env.HOME = homeDir;
  process.env.PAI_HOME = paiHome;
  process.env.PAI_CONFIG_FILE = join(paiHome, "config.json");
  ({ loadConfig } = await import("./config.js"));
});

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

describe("loadConfig with os.userInfo() throwing ERR_SYSTEM_ERROR", () => {
  it("does not throw and still yields a per-user Postgres connection string", () => {
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().postgres?.connectionString).toMatch(/pai_/);
  });
});
