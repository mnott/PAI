/**
 * Preloaded by `bun test` (bunfig.toml): refuse to run.
 *
 * The suite is vitest. Under Bun, os.homedir() ignores a runtime change to
 * process.env.HOME, and vitest's setup-home-guard.ts never runs, so tests that
 * sandbox HOME write the REAL home directory instead: claude-json.test.ts
 * overwrote ~/.claude.json with its fixture this way. Use `npm test`.
 */
throw new Error("bun test is not supported here: it cannot sandbox HOME and writes the real ~/.claude.json. Run `npm test` (vitest).");
