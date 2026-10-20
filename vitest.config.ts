import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before any test module is imported, which is the only point early
    // enough: paths derived from homedir() are frequently module-level
    // constants, evaluated on import. See test/setup-home-guard.ts.
    setupFiles: ["./test/setup-home-guard.ts"],
    include: process.env.PAI_WORKER_ORCHESTRATOR === "1" ? ["**/*.{test,spec}.?(c|m)[jt]s?(x)", ".pai-scratch/**/*.test.ts"] : ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Worker scratch dirs (gitignored in .gitignore) must never be test roots:
    // a scratch copy of a source file crashes collection ("Cannot find module
    // './ledger.js'") and forks a failing worker. Keep vitest's own defaults
    // and add the scratch patterns; .pai-scratch stays included on purpose —
    // the orchestrator include list above relies on it.
    exclude: [...configDefaults.exclude, "tmp/**", ".tmp-*/**"],
  },
});
