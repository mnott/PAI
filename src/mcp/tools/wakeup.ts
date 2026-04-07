/**
 * MCP tool handler: memory_wakeup
 *
 * Returns the L0+L1 wake-up context block for a project:
 *   L0 — user identity from ~/.pai/identity.txt
 *   L1 — recent session note highlights (Work Done / Key Decisions / Next Steps)
 */

import type { Database } from "better-sqlite3";
import { buildWakeupContext } from "../../memory/wakeup.js";
import { detectProjectFromPath } from "./types.js";
import type { ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Default token budget (constant, overridable per call)
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_BUDGET = 800;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface MemoryWakeupParams {
  /** Project slug or absolute path. Omit to auto-detect from process.cwd(). */
  project?: string;
  /** L1 token budget. Default 800. */
  token_budget?: number;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export function toolMemoryWakeup(
  registryDb: Database,
  params: MemoryWakeupParams
): ToolResult {
  try {
    const tokenBudget = params.token_budget ?? DEFAULT_TOKEN_BUDGET;

    // Resolve the project root path
    let rootPath: string | undefined;

    if (params.project) {
      // Try slug lookup first
      const bySlug = registryDb
        .prepare("SELECT root_path FROM projects WHERE slug = ?")
        .get(params.project) as { root_path: string } | undefined;

      if (bySlug) {
        rootPath = bySlug.root_path;
      } else {
        // Maybe it's an absolute path — try path-based detect
        const detected = detectProjectFromPath(registryDb, params.project);
        if (detected) rootPath = detected.root_path;
      }
    } else {
      // Auto-detect from cwd
      const detected = detectProjectFromPath(registryDb, process.cwd());
      if (detected) rootPath = detected.root_path;
    }

    const wakeupBlock = buildWakeupContext(rootPath, tokenBudget);

    if (!wakeupBlock) {
      return {
        content: [
          {
            type: "text",
            text: "No wake-up context available. Create ~/.pai/identity.txt for L0 identity, or ensure session notes exist for L1 story.",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `WAKEUP CONTEXT\n\n${wakeupBlock}`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `Wakeup context error: ${String(e)}` }],
      isError: true,
    };
  }
}
