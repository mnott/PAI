/**
 * Shim — re-exports from postgres/ directory so existing importers
 * continue to work without modification. See postgres/index.ts.
 */
export { PostgresBackend, buildPgTsQuery } from "./postgres/index.js";
export type { PostgresConfig } from "./postgres/index.js";
