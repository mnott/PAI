/**
 * Shim — re-exports from session/ directory so existing importers (cli/index.ts)
 * continue to work without modification. See session/index.ts for the implementation.
 */
export { registerSessionCommands } from "./session/index.js";
