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

/** The one place the Postgres URL is built: connectionString wins, else the parts with PAI's defaults. */
export function postgresConnectionString(config: PostgresConfig): string {
  return (
    config.connectionString ??
    `postgresql://${config.user ?? "pai"}:${config.password ?? "pai"}@${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database ?? "pai"}`
  );
}
