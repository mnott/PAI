import { configDefaults, defineConfig } from "vitest/config";

const include = process.env.PAI_WORKER_ORCHESTRATOR === "1" ? ["**/*.{test,spec}.?(c|m)[jt]s?(x)", ".pai-scratch/**/*.test.ts"] : ["**/*.{test,spec}.?(c|m)[jt]s?(x)"];
// Worker scratch dirs (gitignored in .gitignore) must never be test roots:
// a scratch copy of a source file crashes collection ("Cannot find module
// './ledger.js'") and forks a failing worker. Keep vitest's own defaults
// and add the scratch patterns; .pai-scratch stays included on purpose —
// the orchestrator include list above relies on it.
const exclude = [...configDefaults.exclude, "tmp/**", ".tmp-*/**"];
// Test files that drive a real headless Chrome. Run unbounded next to every other
// file they pile up one Chrome per CPU worker and, under load, Chrome dies or
// returns an empty --dump-dom ("no probe result in dump"), so they get a capped pool.
const browser = ["src/router/cockpit-*.test.ts", "src/router/cockpit-page/**/*.test.ts"];
const BROWSER_WORKERS = 3;

export default defineConfig({
  test: {
    // Runs before any test module is imported, which is the only point early
    // enough: paths derived from homedir() are frequently module-level
    // constants, evaluated on import. See test/setup-home-guard.ts.
    setupFiles: ["./test/setup-home-guard.ts"],
    projects: [
      { extends: true, test: { name: "unit", sequence: { groupOrder: 1 }, include, exclude: [...exclude, ...browser] } },
      { extends: true, test: { name: "browser", sequence: { groupOrder: 2 }, include: browser, exclude, maxWorkers: BROWSER_WORKERS } },
    ],
  },
});
