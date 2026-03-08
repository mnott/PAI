/**
 * Shim — re-exports from project/ directory so existing importers (cli/index.ts)
 * continue to work without modification. See project/index.ts for the implementation.
 */
export { registerProjectCommands, cmdGo } from "./project/index.js";
