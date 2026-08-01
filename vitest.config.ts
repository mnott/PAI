import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before any test module is imported, which is the only point early
    // enough: paths derived from homedir() are frequently module-level
    // constants, evaluated on import. See test/setup-home-guard.ts.
    setupFiles: ["./test/setup-home-guard.ts"],
  },
});
