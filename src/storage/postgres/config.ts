/**
 * PostgresConfig — connection options for the PostgresBackend.
 */
export interface PostgresConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** Maximum pool connections. Default 5. */
  maxConnections?: number;
  /** Connection timeout in ms. Default 5000. */
  connectionTimeoutMs?: number;
}
