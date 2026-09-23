import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import { initializeSchema } from "./sqlite/registry-schema.js";
import { SQLiteRegistryBackend } from "./registry-sqlite.js";
import { defineRegistryBackendContract } from "./registry-contract.js";

defineRegistryBackendContract("sqlite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-registry-backend-"));
  const db = new DatabaseCtor(join(dir, "registry.db"));
  initializeSchema(db);

  return {
    backend: new SQLiteRegistryBackend(db),
    cleanup: async () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
