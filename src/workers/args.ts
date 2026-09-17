/**
 * args.ts — parse the claude-args tail that `pai worker run` receives.
 *
 * The runner needs a few things out of the caller's argument vector: the
 * prompt (for the default label), the requested --output-format (so the final
 * print matches what plain `claude -p` would have produced), whether the
 * caller already chose a --model or an --mcp-config (both suppress the
 * defaults the runner would otherwise force), any --mcp allowlist names, and
 * whether they appended their own system prompt (the worker contract is then
 * added alongside, not instead). Everything is passed through untouched — the
 * runner never rewrites the caller's task.
 */

export interface ParsedRunnerArgs {
  /** Prompt string after -p/--print, when the run is headless. */
  prompt: string | null;
  /** Caller's --output-format: text (default), json, or stream-json. */
  outputFormat: "text" | "json" | "stream-json";
  /** Args to hand to claude (minus --output-format/--verbose, which we add). */
  rest: string[];
  /** Headless: a -p/--print flag is present. */
  headless: boolean;
  /** Caller passed --model (or --model=…): do not force the provider model. */
  callerModel: boolean;
  /** Caller passed --mcp-config (or --mcp-config=…): keep their MCP setup. */
  callerMcpConfig: boolean;
  /** Caller passed --append-system-prompt: the contract is added alongside. */
  callerSystemPrompt: boolean;
  /** --mcp values (repeatable, comma-separated inside one flag). */
  mcp: string[];
}

export function parseRunnerArgs(argv: string[]): ParsedRunnerArgs {
  let prompt: string | null = null;
  let outputFormat: ParsedRunnerArgs["outputFormat"] = "text";
  const rest: string[] = [];
  let headless = false;
  let callerModel = false;
  let callerMcpConfig = false;
  let callerSystemPrompt = false;
  const mcp: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-p" || a === "--print") {
      headless = true;
      rest.push(a);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        prompt = argv[i + 1];
        rest.push(prompt);
        i += 1;
      }
    } else if (a === "--output-format") {
      const v = argv[i + 1];
      if (v === "json" || v === "stream-json") outputFormat = v;
      i += 1; // dropped; the runner prints the result in this format itself
    } else if (a.startsWith("--output-format=")) {
      const v = a.slice("--output-format=".length);
      if (v === "json" || v === "stream-json") outputFormat = v;
    } else if (a === "--verbose") {
      // dropped; re-added by the runner
    } else if (a === "--mcp") {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("-")) {
        mcp.push(v);
        i += 1;
      }
    } else if (a.startsWith("--mcp=")) {
      mcp.push(a.slice("--mcp=".length));
    } else {
      if (a === "--model") callerModel = true;
      if (a.startsWith("--model=")) callerModel = true;
      if (a === "--mcp-config") callerMcpConfig = true;
      if (a.startsWith("--mcp-config=")) callerMcpConfig = true;
      if (a === "--append-system-prompt") callerSystemPrompt = true;
      if (a.startsWith("--append-system-prompt=")) callerSystemPrompt = true;
      if (
        prompt === null && !a.startsWith("-") && rest.length > 0 &&
        (rest[rest.length - 1] === "-p" || rest[rest.length - 1] === "--print")
      ) {
        prompt = a;
      }
      rest.push(a);
    }
    i += 1;
  }

  return { prompt, outputFormat, rest, headless, callerModel, callerMcpConfig, callerSystemPrompt, mcp };
}

/**
 * Turn `-p "<prompt>"` into bare `-p` (same for --print): for stream-json
 * stdin runs the prompt moves to the first user message on stdin, so the
 * value must not stay on the command line. Only prompt values directly
 * following the flag are touched; everything else passes through.
 */
export function stripPromptValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const isPrint = a === "-p" || a === "--print";
    out.push(a);
    if (isPrint && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      i += 1; // drop the prompt value; the flag itself stays
    }
  }
  return out;
}

/** Collapse whitespace and cut to n chars with an ellipsis (label rendering). */
export function shortText(s: unknown, n: number): string {
  const t = String(s ?? "").split(/\s+/).filter(Boolean).join(" ");
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}
