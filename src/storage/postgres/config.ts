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

/** Connection timeout used when neither the config nor the shipped defaults set one. */
export const DEFAULT_PG_CONNECTION_TIMEOUT_MS = 5000;

/** The one place the Postgres URL is built: connectionString wins, else the parts with PAI's defaults. */
export function postgresConnectionString(config: PostgresConfig): string {
  return (
    config.connectionString ??
    `postgresql://${config.user ?? "pai"}:${config.password ?? "pai"}@${config.host ?? "localhost"}:${config.port ?? 5432}/${config.database ?? "pai"}`
  );
}

/** Database and role the storage backend connects to, read from the same URL it uses. */
export function postgresTarget(config: PostgresConfig): { database: string; user: string } {
  const url = new URL(postgresConnectionString(config));
  return {
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username),
  };
}
