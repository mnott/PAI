/**
 * Process-wide storage accessors (getStorageBackend/getRegistryBackend/
 * closeStorage): caching, cache invalidation on close, and that a process
 * which only calls getStorageBackend() exits on its own instead of hanging
 * on an open Postgres pool.
 */

import { describe, it, expect, afterEach } from "vitest";
import pg from "pg";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getStorageBackend,
  getRegistryBackend,
  closeStorage,
  __resetStorageForTests,
} from "./factory.js";
import { loadConfig } from "../daemon/config.js";

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
// backend.ts resolves docker/init.sql relative to the built dist/ layout,
// which does not match ts-source paths under vitest — read it directly here
// instead (same workaround as postgres/kg-and-registry-ddl.test.ts).
const repoRoot = join(here, "..", "..");
const initSql = readFileSync(join(repoRoot, "docker", "init.sql"), "utf-8");

afterEach(async () => {
  await closeStorage();
  __resetStorageForTests();
});

describe("process-wide storage accessors", () => {
  it("concurrent getRegistryBackend() calls share one instance", async () => {
    const [a, b] = await Promise.all([getRegistryBackend(), getRegistryBackend()]);
    expect(a).toBe(b);
  });

  it("closeStorage() clears the cache so a later call creates a new instance", async () => {
    const first = await getStorageBackend();
    await closeStorage();
    const second = await getStorageBackend();
    expect(second).not.toBe(first);
  });

  it("closeStorage() is idempotent", async () => {
    await getStorageBackend();
    await closeStorage();
    await expect(closeStorage()).resolves.toBeUndefined();
  });

  it("getStorageBackend() and getRegistryBackend() share one Postgres pool", async () => {
    if (loadConfig().storageBackend !== "postgres") return;
    const storage = await getStorageBackend();
    const registry = await getRegistryBackend();
    const storagePool = (storage as unknown as { getPool: () => unknown }).getPool();
    const registryPool = (registry as unknown as { pool: unknown }).pool;
    expect(registryPool).toBe(storagePool);
  });
});

describe("process-wide storage accessors: child process exit", () => {
  function scratchTargets(): { scratchUrl: string; adminUrl: string; dbName: string } {
    const base = loadConfig().postgres?.connectionString;
    if (!base) {
      throw new Error("postgres.connectionString not configured — cannot run scratch-db test");
    }
    const dbName = `pai_test_factory_${Math.random().toString(36).slice(2, 10)}`;
    const scratch = new URL(base);
    scratch.pathname = `/${dbName}`;
    const admin = new URL(base);
    admin.pathname = "/postgres";
    return { scratchUrl: scratch.toString(), adminUrl: admin.toString(), dbName };
  }

  it("a child that only calls getStorageBackend() exits by itself within 5s", async () => {
    const { scratchUrl, adminUrl, dbName } = scratchTargets();
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }

    // Pre-apply base schema so the child's ensureDatabase() finds pai_chunks
    // already present and never needs to read docker/init.sql off disk (see
    // the ts-source-vs-dist path note above).
    const scratchPool = new Pool({ connectionString: scratchUrl, max: 1 });
    try {
      await scratchPool.query(initSql);
    } finally {
      await scratchPool.end();
    }

    const dir = mkdtempSync(join(tmpdir(), "pai-factory-exit-"));
    try {
      const configFile = join(dir, "config.json");
      writeFileSync(
        configFile,
        JSON.stringify({ storageBackend: "postgres", postgres: { connectionString: scratchUrl } }),
        "utf8"
      );

      const scriptFile = join(dir, "get-storage.ts");
      writeFileSync(
        scriptFile,
        `import { getStorageBackend } from ${JSON.stringify(join(here, "factory.ts"))};\n` +
          `await getStorageBackend();\n`,
        "utf8"
      );

      // If getStorageBackend() left the pg pool open with no beforeExit
      // cleanup, this would hang and execFileSync would throw on timeout.
      execFileSync("bun", [scriptFile], {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, PAI_CONFIG_FILE: configFile },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      const admin2 = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await admin2.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await admin2.end();
      }
    }
  }, 15_000);

  it("a child holding a setInterval plus the pool does not exit on its own", async () => {
    const { scratchUrl, adminUrl, dbName } = scratchTargets();
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }

    const scratchPool = new Pool({ connectionString: scratchUrl, max: 1 });
    try {
      await scratchPool.query(initSql);
    } finally {
      await scratchPool.end();
    }

    const dir = mkdtempSync(join(tmpdir(), "pai-factory-timer-"));
    try {
      const configFile = join(dir, "config.json");
      writeFileSync(
        configFile,
        JSON.stringify({ storageBackend: "postgres", postgres: { connectionString: scratchUrl } }),
        "utf8"
      );

      const scriptFile = join(dir, "get-storage-with-timer.ts");
      writeFileSync(
        scriptFile,
        `import { getStorageBackend } from ${JSON.stringify(join(here, "factory.ts"))};\n` +
          `await getStorageBackend();\n` +
          `setInterval(() => {}, 1000);\n`,
        "utf8"
      );

      const child = spawn("bun", [scriptFile], {
        env: { ...process.env, PAI_CONFIG_FILE: configFile },
      });
      let exited = false;
      child.once("exit", () => {
        exited = true;
      });

      // allowExitOnIdle only lets the process exit when nothing else holds
      // the event loop open — the setInterval here must still keep it alive.
      await new Promise((r) => setTimeout(r, 2_000));
      expect(exited).toBe(false);

      child.kill();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      const admin2 = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await admin2.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await admin2.end();
      }
    }
  }, 15_000);
});
