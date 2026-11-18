/**
 * MCP tool handlers: code_explore, code_search, code_callers
 *
 * Code graph surface: one-call repo mapping (definitions, source, callers,
 * blast radius) backed by the PAI database. The repo is indexed on first use
 * and reconciled on every query.
 */

import type { StorageBackend } from "../../storage/interface.js";
import type { ToolResult } from "./types.js";
import { resolveRoot, ensureFresh, explore, searchSymbols, callers } from "../../codegraph/api.js";

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(tool: string, e: unknown): ToolResult {
  return { content: [{ type: "text", text: `${tool} error: ${String(e)}` }], isError: true };
}

export interface CodeExploreParams {
  /** A question or symbol names. */
  query: string;
  /** Repository root. Default: resolved from the current directory. */
  root?: string;
  /** Output budget in tokens. Default 4000. */
  budget_tokens?: number;
  /** Call-graph depth. */
  depth?: number;
}

export async function toolCodeExplore(backend: StorageBackend, params: CodeExploreParams): Promise<ToolResult> {
  try {
    const root = params.root ?? resolveRoot(process.cwd());
    await ensureFresh(backend, root);
    const r = await explore(backend, root, params.query, {
      budgetTokens: params.budget_tokens ?? 4000,
      depth: params.depth,
    });
    return ok(r.text);
  } catch (e) {
    return fail("code_explore", e);
  }
}

export interface CodeSearchParams {
  query: string;
  root?: string;
  limit?: number;
}

export async function toolCodeSearch(backend: StorageBackend, params: CodeSearchParams): Promise<ToolResult> {
  try {
    const root = params.root ?? resolveRoot(process.cwd());
    await ensureFresh(backend, root);
    const hits = await searchSymbols(backend, root, params.query, params.limit);
    return ok(JSON.stringify(hits, null, 2));
  } catch (e) {
    return fail("code_search", e);
  }
}

export interface CodeCallersParams {
  name: string;
  root?: string;
  limit?: number;
}

export async function toolCodeCallers(backend: StorageBackend, params: CodeCallersParams): Promise<ToolResult> {
  try {
    const root = params.root ?? resolveRoot(process.cwd());
    await ensureFresh(backend, root);
    const hits = await callers(backend, root, params.name, params.limit);
    return ok(JSON.stringify(hits, null, 2));
  } catch (e) {
    return fail("code_callers", e);
  }
}
