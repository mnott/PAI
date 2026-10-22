/**
 * types.ts — the shape of a security rule. Rules live in `*.rule.yaml` files
 * (built-ins under ./builtin/, user rules under PAI_HOME/rules and
 * .pai/rules), so patterns can be extended without editing TypeScript, and
 * every rule carries its own fixtures.
 */

export type RuleSeverity = "block" | "confirm" | "warn" | "off";

export interface Rule {
  id: string;
  severity: RuleSeverity;
  /** Regex on the tool name; default "Bash". */
  tool?: string;
  /** Regex source; flags come from `flags`. Required unless severity is "off". */
  match?: string;
  flags?: string;
  reason: string;
  /** Built-in fixtures: every `match` string must hit, every `no_match` must not. */
  tests?: { match?: string[]; no_match?: string[] };
}

/** Where a rule came from, for `pai rules list`. */
export interface LoadedRule extends Rule {
  source: string;
}
