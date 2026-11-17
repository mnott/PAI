/**
 * Current code for every MCP tool call. The PAI MCP server is a stdio child of a Claude Code session and
 * lives for days; most tools run in-process (src/workers/*, config ops), so after a release they kept
 * running the logic the session started with (2026-11-17: worker_say refused a value the current source
 * accepts, while `pai worker say` worked). The session itself (stdin/stdout, tool list) must not be
 * dropped, and Claude Code does not restart a stdio server on its own, so instead each tool call compares
 * the dist build id with the one at start (same id as src/daemon/dist-watch.ts) and, when it differs,
 * runs the handler of a fresh, cache-busted import of the new build. Anything unreadable (mid-build,
 * import error, tool missing in the new build) falls back to the handler this process started with.
 */
export type ToolHandler = (...args: any[]) => unknown;

export interface HotDeps {
  /** Current dist build id; undefined when unreadable (mid-build). */
  readId: () => string | undefined;
  startId: string | undefined;
  /** Handlers of the build with this id, keyed by tool name. */
  loadFresh: (id: string) => Promise<Map<string, ToolHandler>>;
  log?: (line: string) => void;
}

/** Patches `server.tool` so each handler dispatches to the newest build; returns this build's own handlers. */
export function hotTools(server: { tool: (...a: any[]) => unknown }, d: HotDeps): Map<string, ToolHandler> {
  const own = new Map<string, ToolHandler>();
  const fresh = new Map<string, Map<string, ToolHandler>>();
  const orig = server.tool.bind(server);
  server.tool = (...a: any[]) => {
    const name = a[0] as string;
    const handler = a[a.length - 1] as ToolHandler;
    own.set(name, handler);
    a[a.length - 1] = async (...args: any[]) => {
      const id = d.readId();
      if (id !== undefined && d.startId !== undefined && id !== d.startId) {
        let h: ToolHandler | undefined;
        try {
          let m = fresh.get(id);
          if (!m) {
            m = await d.loadFresh(id);
            fresh.set(id, m);
          }
          h = m.get(name);
        } catch (e) {
          d.log?.(`hot reload of ${name} failed, using start-up code: ${e instanceof Error ? e.message : String(e)}`);
        }
        // only loading falls back; a throw from the new handler is its real answer (no second run of side effects)
        if (h) return await h(...args);
      }
      return handler(...args);
    };
    return orig(...a);
  };
  return own;
}
