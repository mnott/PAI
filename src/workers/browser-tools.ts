/**
 * browser-tools.ts — what `--no-browser` strips: --chrome, every browser MCP
 * tool grant (mcp__claude-in-chrome__*, browsr, playwright, …) and browser
 * server names, from the caller's claude args. The PreToolUse worker guard
 * denies the same tools (hooks/ts/lib/worker-guard.ts) when
 * PAI_WORKER_NO_BROWSER=1.
 */

const BROWSER_SERVER = /chrome|browsr|browser|playwright|puppeteer/i;

/** A browser MCP server name (bare, e.g. "browsr") or tool name (mcp__browsr__open). */
export function isBrowserTool(name: string): boolean {
  const server = /^mcp__(.+?)(__|$)/.exec(name)?.[1] ?? name;
  return BROWSER_SERVER.test(server) && (name.startsWith("mcp__") || !name.includes("__"));
}

const keepNonBrowser = (list: string): string[] =>
  list.split(",").map((s) => s.trim()).filter((s) => s && !isBrowserTool(s));

/** claude args without --chrome and browser tool grants (an emptied --allowedTools goes too). */
export function stripBrowserArgs(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--chrome") continue;
    if (a === "--allowedTools" && i + 1 < rest.length && !rest[i + 1].startsWith("-")) {
      const kept = keepNonBrowser(rest[++i]);
      if (kept.length) out.push(a, kept.join(","));
    } else if (a.startsWith("--allowedTools=")) {
      const kept = keepNonBrowser(a.slice("--allowedTools=".length));
      if (kept.length) out.push(`--allowedTools=${kept.join(",")}`);
    } else out.push(a);
  }
  return out;
}

/** Comma-list entries (--mcp values, class MCP) without browser servers. */
export function stripBrowserNames(names: string[]): string[] {
  return names.map((n) => keepNonBrowser(n).join(",")).filter(Boolean);
}
