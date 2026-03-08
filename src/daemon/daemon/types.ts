/**
 * IPC protocol types and internal backend interface types for the PAI daemon.
 */

/** Inbound request from an MCP shim over the Unix Domain Socket. */
export interface IpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** Outbound response from the daemon. */
export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Internal interface for accessing the raw SQLite DB from SQLiteBackend.
 * Avoids a circular dependency while keeping type safety.
 */
export interface SQLiteBackendWithDb {
  getRawDb(): import("better-sqlite3").Database;
}

/**
 * Internal interface for accessing the pg.Pool from PostgresBackend.
 * Mirrors SQLiteBackendWithDb — avoids a circular dependency while keeping type safety.
 */
export interface PostgresBackendWithPool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPool?(): any;
}
