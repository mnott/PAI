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
  const { database, user } = postgresFullTarget(config);
  return { database, user };
}

/** Where a backup or restore connects: the names plus the server the connection string names. */
export interface PgTarget {
  database: string;
  user: string;
  host?: string;
  port?: number;
  password?: string;
  /** The URL the storage backend connects with. */
  connectionString?: string;
}

/** Postgres truncates identifiers beyond this many bytes. */
export const PG_IDENT_MAX_BYTES = 63;

/** Throws unless `name` is usable as a database or role name: non-empty, no NUL, not option-like, at most `maxBytes`. */
export function assertPgName(name: string, kind: string, maxBytes = PG_IDENT_MAX_BYTES): void {
  if (name === "" || name.includes("\0") || name.startsWith("-")) {
    throw new Error(`invalid Postgres ${kind} name ${JSON.stringify(name)}`);
  }
  if (Buffer.byteLength(name) > maxBytes) {
    throw new Error(`Postgres ${kind} name "${name}" is longer than ${maxBytes} bytes`);
  }
}

/** Double-quoted SQL identifier; keeps case and neutralises any character. */
export function quoteIdent(name: string): string {
  if (name === "" || name.includes("\0")) throw new Error(`invalid Postgres identifier ${JSON.stringify(name)}`);
  return `"${name.replace(/"/g, '""')}"`;
}

/** Full target (names and server) read from the URL the storage backend uses. */
export function postgresFullTarget(config: PostgresConfig): PgTarget & { connectionString: string } {
  const connectionString = postgresConnectionString(config);
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  assertPgName(database, "database");
  assertPgName(user, "user");
  return {
    database,
    user,
    host: url.hostname.replace(/^\[|\]$/g, "") || "localhost",
    port: url.port ? Number(url.port) : 5432,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    connectionString,
  };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** True when the target is the local server PAI's `pai-pgvector` container publishes; anything else is an external server reached directly. */
export function isContainerTarget(t: { host?: string }): boolean {
  return t.host === undefined || LOCAL_HOSTS.has(t.host.toLowerCase());
}
