## Tool-call repair rules

The router repairs local models' tool calls before Claude Code sees them. Which forms get repaired is decided by a versioned YAML rules file, not by code: the shipped `tool-call-rules.default.yaml`, plus your own files in `<PAI home>/tool-call-rules/`. Config `router.toolCallRules` maps a provider (or provider and model, `"*"` for any) to a file:

```yaml
router:
  toolCallRules:
    dir: tool-call-rules          # under the PAI home
    providers:
      strata: { Coder-L: coder-l.yaml, "*": strata.yaml }
  toolCallRulesStaleDays: 14
```

```yaml
version: 1
inherits: default                 # the shipped file, or a path relative to this file
rules:
  - id: open-parameter-eq         # unique; a rule of the same id replaces the inherited one
    kind: opener                  # opener | junk_line | closer | name_cut | bool_true | bool_false
    pattern: '<[ \t]*parameter[ \t]*=[ \t]*([\w\-]+)[ \t]*>[ \t]*\r?\n?'   # regex; opener and name_cut capture the parameter name in group 1
    added: 2026-10-25
    sample: af04af55f0e2          # raw log id the form was first seen in
    note: why the rule exists
    example:                      # the broken tool_use input (or `text:` raw tool-call markup) ...
      tool: Grep
      input: { pattern: x, "-n": "true\n</parameter\n<parameter=-C>\n15" }
    expect:                       # ... and what it must be repaired to
      { pattern: x, "-n": true, "-C": 15 }
    probe:                        # optional: a prompt and tool schema that provoke the form (rules probe)
      prompt: "Use the Grep tool: ..."
      tool: { name: Grep, input_schema: { type: object, properties: { pattern: { type: string } } } }
    # optional: disabled: true, expires: 2027-01-01, scope: text (only for markup parsed out of answer text), typed_only: true (junk_line: never strip from string values)
```

What the kinds do, for every tool_use input against the request's declared tool schema:

- `opener`: a value that holds an opener of another declared, not yet set parameter is split there (`"true\n</parameter\n<parameter=-C>\n15"` becomes `-n: true`, `-C: 15`).
- `closer`: a whole line that ends the value; it and everything after it are dropped.
- `junk_line`: whole lines stripped from the tail of a value (anywhere in a number or boolean value).
- `name_cut`: a parameter name that swallowed markup (`command </parameter`) is cut to its clean name; a cut name that is not declared is dropped.
- `bool_true` / `bool_false`: whole-value spellings coerced for boolean parameters. Numbers and integers are coerced from digit strings.

A value no rule matches is never touched; file content stays verbatim unless a rule matches a whole line. Edits to a rules file are picked up within 5 seconds, or at once with `pai models rules reload`. Every regex is validated first; a bad file is refused, the previous rules stay in force and the reason is logged. Hit counts per rule are kept in `<PAI home>/logs/tool-call-rule-hits.json` (flushed every minute); `rules list` marks a rule stale when it has not hit for `toolCallRulesStaleDays` days. Nothing is deleted automatically.

For a local engine that does not parse tool calls at all and returns them as answer text, set `toolParsing: router` on its provider in `workers.yaml`: the router then parses `<tool_call>`, `<function=...>` and `<invoke>` markup (and JSON arguments) into tool_use blocks with the same rules, and only falls back to the one-shot retry when that fails.

For a new model or another quantisation: `pai models rules probe --provider NEW --from existing.yaml --out new.yaml` shows which rules still fire, keeps the others as `unconfirmed: true` and writes `new.yaml.CANDIDATES` with the calls that still show markup or miss a required argument, as raw material for a new rule.
