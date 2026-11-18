/**
 * Optional external graph source: a read-only edge view in another Postgres schema
 * (columns src_key, dst_key, kind, page_hint, updated_at). Joined into graph queries at
 * read time; nothing is copied. Off by default; the connection string is read from the
 * environment variable named in config (`externalGraph.connectionEnv`), never from config itself.
 */

import pg from "pg";
import { loadConfig } from "../daemon/config.js";

export interface ExternalEdge {
  src: string;
  dst: string;
  kind: string;
  pageHint: string | null;
  updatedAt: string | null;
}

export interface ExternalEdgeResult {
  edges: ExternalEdge[];
  /** One line saying why edges are missing; null when the source answered or is not configured. */
  note: string | null;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function externalEdges(keys: string[]): Promise<ExternalEdgeResult> {
  const cfg = loadConfig().externalGraph;
  if (!cfg || cfg.enabled !== true) return { edges: [], note: null };
  const schema = cfg.schema ?? "paperfull_dms";
  const view = cfg.view ?? "graph_edges";
  if (!IDENT.test(schema) || !IDENT.test(view)) return { edges: [], note: "external graph: schema/view name invalid, skipped" };
  const dsn = cfg.connectionEnv ? process.env[cfg.connectionEnv] : undefined;
  if (!dsn) return { edges: [], note: `external graph: environment variable ${cfg.connectionEnv || "(unset)"} is empty, skipped` };
  if (keys.length === 0) return { edges: [], note: null };
  const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  try {
    await client.connect();
    const r = await client.query<{ src_key: string; dst_key: string; kind: string; page_hint: string | null; updated_at: Date | string | null }>(
      `SELECT src_key, dst_key, kind, page_hint, updated_at FROM "${schema}"."${view}"
       WHERE src_key = ANY($1::text[]) OR dst_key = ANY($1::text[]) LIMIT 500`,
      [keys],
    );
    return {
      edges: r.rows.map((x) => ({
        src: x.src_key, dst: x.dst_key, kind: x.kind, pageHint: x.page_hint,
        updatedAt: x.updated_at == null ? null : new Date(x.updated_at).toISOString(),
      })),
      note: null,
    };
  } catch (e) {
    return { edges: [], note: `external graph unreachable (${(e as Error).message.slice(0, 60)}), shown without it` };
  } finally {
    await client.end().catch(() => undefined);
  }
}
