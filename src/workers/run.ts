/**
 * run.ts — the worker runner (port of the glm / glm-run pair, provider-neutral).
 *
 * One claude-code process per call, pointed at the chosen provider:
 *
 *   - env: ANTHROPIC_BASE_URL/AUTH_TOKEN from the provider (token from its
 *     key file, never from the environment), the three DEFAULT_*_MODEL vars,
 *     the provider's extra env, nonessential traffic off, and ANTHROPIC_API_KEY
 *     stripped so nothing can fall back to Anthropic billing. Headless runs
 *     also drop the spawner's session identity (messaging socket, session id,
 *     nesting markers) — inherited, a worktree child starts tool-blind.
 *     OpenAI-protocol providers point at the PAI proxy instead (started on
 *     demand, the provider name in the URL path); codex-engine providers run
 *     the Codex CLI.
 *   - headless (-p): strict empty MCP config unless the caller brings one or
 *     names servers via --mcp / a role (then a filtered <id>.mcp.json), the
 *     core tool grants the caller did not bring (a headless run cannot
 *     approve a permission-gated tool mid-flight — with no grant at all,
 *     claude drops the file/shell tools entirely and the worker is
 *     tool-blind), PAI_WORKER=1 so PAI's per-session hooks leave it alone,
 *     the worker
 *     contract appended to the system prompt, `--input-format stream-json`
 *     with the prompt as the first stdin user message (the operator socket
 *     can add more mid-run), stream-json mirroring (every line stamped `_ts`)
 *     into <logDir>/<id>.jsonl, a live <id>.status for ps/follow/status line
 *     (context meter included), ledger lines, result printed in the caller's
 *     --output-format (json adds the parsed `report`), and the follow pane
 *     (unless --no-pane).
 *   - interactive: no MCP/tool restriction by default, no pane,
 *     ENABLE_TOOL_SEARCH=true. A project that pinned a list with `pai
 *     project mcp` / `pai project tools` gets `--strict-mcp-config
 *     --mcp-config <filtered>` / `--tools <list>` built the same way a
 *     headless run's allowlist is; an explicit --mcp or --tools on this
 *     command line still wins over the project's pin.
 *
 * Auto-routed runs that die of a quota error before the first tool call are
 * restarted on the next provider in routing order (WORKER-REROUTE ledger line).
 */

/** Barrel: the implementation lives in ./run/*.ts; every import path of run.js keeps working. */
export { buildRunEnv } from "./run-env.js";
export * from "./run/argv.js";
export * from "./run/escalate.js";
export * from "./run/execute.js";
export * from "./run/finalise.js";
export * from "./run/gate.js";
export * from "./run/model.js";
export * from "./run/pane-handles.js";
export * from "./run/provider-test.js";
export * from "./run/stream.js";
export * from "./run/types.js";
export * from "./run/worker.js";
