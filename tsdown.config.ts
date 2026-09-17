import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/index.ts",
    "src/cli/program.ts",
    "src/daemon/index.ts",
    "src/daemon-mcp/index.ts",
  ],
  format: "esm",
  target: "node20",
  outDir: "dist",

  // MUST stay false.
  //
  // dist/hooks/*.mjs are executed by every LIVE Claude Code session on every
  // tool call, through symlinks in ~/.claude/Hooks/. Cleaning the output
  // directory deletes them for the second or so tsdown takes to rebuild, and
  // any hook firing in that window dies with "No such file or directory" —
  // in every other open session, not just this one. Measured: a single
  // `bun run build` produced 318 such failures across a 5-file sample.
  //
  // Nothing here needs the clean: every entry below is rewritten each build,
  // and the hook and skill-stub steps replace their own outputs atomically.
  clean: false,
  dts: true,
  sourcemap: true,
  shims: true,
});
