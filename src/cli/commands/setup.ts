/**
 * Shim — re-exports from setup/ directory so existing importers (cli/index.ts)
 * continue to work without modification. See setup/index.ts for the implementation.
 */
export { registerSetupCommand } from "./setup/index.js";
