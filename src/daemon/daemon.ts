/**
 * Shim — re-exports serve() from daemon/ directory so existing importers
 * continue to work without modification. See daemon/index.ts.
 */
export { serve } from "./daemon/index.js";
