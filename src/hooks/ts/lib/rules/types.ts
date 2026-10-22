/**
 * types.ts — the shape of a security rule. Rules live in `*.rule.yaml` files
 * (built-ins under ./builtin/, user rules under PAI_HOME/rules and
 * .pai/rules), so patterns can be extended without editing TypeScript, and
 * every rule carries its own fixtures.
 */

export type RuleSeverity = "block" | "confirm" | "warn" | "off";

/** One step of a sequence rule: a regex on the tool's content, optionally pinned to a tool. */
export interface RuleSequenceStep {
  /** Regex on the tool name; any tool when absent. */
  tool?: string;
  /** Regex source; flags come from `flags`. */
  match: string;
  flags?: string;
}

/**
 * A two-step (or more) pattern: every step must occur within `window_seconds`
 * of the first, in step order when `order` is "strict". Sequence rules are not
 * evaluated live by the hook (eval.ts) — they are for the after-the-fact scan
 * over a transcript (`pai audit scan`).
 */
export interface RuleSequence {
  steps: RuleSequenceStep[];
  window_seconds: number;
  order: "strict" | "any";
}

export interface Rule {
  id: string;
  severity: RuleSeverity;
  /** Regex on the tool name; default "Bash". */
  tool?: string;
  /** Regex source; flags come from `flags`. Required unless severity is "off" or `sequence` is set. */
  match?: string;
  flags?: string;
  /** Multi-step pattern; see RuleSequence. */
  sequence?: RuleSequence;
  /** Also test the text with only the quote marks removed (default: quoted strings are dropped). */
  quoted?: boolean;
  /** Confirm rules only: skip commit messages, grep/rg patterns, echo/printf text and heredoc bodies written to a file (text that mentions the payload without running it). */
  text_ok?: boolean;
  /** Single-step rule for the after-the-fact scan: also test tool results (default: tool calls only). */
  results?: boolean;
  /** Legacy group name shown in deny messages and security events; defaults to the id. */
  category?: string;
  reason: string;
  /** Built-in fixtures: every `match` must hit, every `no_match` must not. For a sequence rule each entry is the list of steps, in step order: a plain string is a Bash-shaped step, an object names the tool a step's content belongs to. */
  tests?: {
    match?: Array<string | string[] | Array<string | { tool?: string; content: string }>>;
    no_match?: Array<string | string[] | Array<string | { tool?: string; content: string }>>;
  };
}

/** Where a rule came from, for `pai rules list`. */
export interface LoadedRule extends Rule {
  source: string;
}
