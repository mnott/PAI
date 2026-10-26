import { defineConfig } from "vitest/config";

// Only the governed core listed in tests/KEPT.md runs. A test is added there
// only with evidence (a real bug it guards, a security/destructive-op guard,
// or an external contract).
export default defineConfig({
  test: {
    // Runs before any test module is imported (homedir()-derived module constants).
    setupFiles: ["./test/setup-home-guard.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    maxWorkers: Number(process.env.PAI_VITEST_MAX_WORKERS ?? 2),
  },
});
