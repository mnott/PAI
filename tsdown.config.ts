import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/index.ts",
    "src/daemon/index.ts",
    "src/daemon-mcp/index.ts",
  ],
  format: "esm",
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: true,
  shims: true,
});
