/**
 * Structural shape of a `pg.Pool` (query-only — no transactions/client
 * checkout). Storage-internal only: every StorageBackend method that used to
 * take a raw pool now lives behind PostgresBackend/StorageBackend, so the
 * only remaining consumer is src/storage/postgres/tunnels.ts. The boundary
 * test (design doc §7) forbids importing this type outside src/storage/.
 */

export interface PgQueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
  fields: Array<{ name: string }>;
}

export interface PgPoolLike {
  query<T = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<T>>;
}
