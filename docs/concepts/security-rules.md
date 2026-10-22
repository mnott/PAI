# Security rules

## What it is

The PreToolUse hook checks every Bash command (and other tool calls) against a set of rules before it runs. Each rule is a small YAML file ending in `.rule.yaml`. A rule has an id, a severity, a pattern and its own test strings. The same rule files are used after the fact by `pai audit scan`, which reads a finished transcript.

## When to use it

- You want to block or confirm a command that PAI does not know about.
- You want to turn off a built-in rule that gets in your way.
- You want to check a finished session or worker for risky behaviour.

## Where rule files are loaded from

In this order. A later file with the same `id` replaces the earlier one.

1. Built-in rules, shipped with the package.
2. `<PAI home>/rules/*.rule.yaml`, your own rules.
3. `.pai/rules/*.rule.yaml` in the project directory.

Project rules are less trusted, because a repository can ship them. A project file may add a new rule or raise the severity of an existing one. It cannot switch a built-in off, lower its severity or swap its pattern for a weaker one. Such a file is ignored and reported. To disable a built-in, put the override in `<PAI home>/rules`.

## Severities

| Severity | Effect |
|---|---|
| `block` | The call is denied. |
| `confirm` | You are asked before it runs. |
| `warn` | The call runs and a security event is logged. |
| `off` | The rule id is disabled. It needs no `match`. |

If several rules hit, the first `block` wins, then the first `confirm`, then the first `warn`.

## Rule file format

```yaml
# git reset --hard throws away uncommitted work.
id: git-reset-hard
severity: confirm
category: dangerous_git
match: /\bgit\s+reset\s+--hard/i
reason: git reset --hard discards uncommitted changes
tests:
  match:
    - git reset --hard HEAD~1
  no_match:
    - git reset HEAD~1
    - git commit -m "git reset --hard notes"
```

Fields:

- `id`: unique name. Reusing an id overrides the earlier rule.
- `severity`: `block`, `confirm`, `warn` or `off`.
- `match`: a regex, written `/source/flags` or as a plain string. The flags `g` and `y` are stripped.
- `flags`: regex flags, if you do not use the `/source/flags` form.
- `tool`: regex on the tool name. Default `Bash`.
- `reason`: shown in the deny message.
- `category`: optional group name for security events. Defaults to the id.
- `quoted`: see below.
- `results`: for single-step rules in `pai audit scan` only. Also test tool results, not just tool calls.
- `tests`: fixtures. Every `match` string must hit, every `no_match` string must not.

## Quoted and unquoted matching

By default a rule tests the command with quoted strings removed. Text inside a commit message or an `echo` is not a command, so `git commit -m "git reset --hard notes"` does not hit the rule above.

Some payloads are dangerous inside quotes, for example a reverse shell inside `bash -c "..."`. A rule with `quoted: true` also tests the text as written and with only the quote marks removed. Anchor such a rule on command position, so a message that merely mentions the payload stays allowed. Every built-in block rule that needs this is marked.

Patterns should not cross `;`, `&&` or `|`. Match within one command segment.

## Sequence rules

A rule with a `sequence` block describes several steps that together are suspicious. Each step alone is ordinary work. The hook does not run sequence rules live. `pai audit scan` evaluates them over a transcript.

```yaml
id: download-then-run
severity: block
reason: a downloaded file is executed shortly after
sequence:
  window_seconds: 300
  order: strict
  steps:
    - tool: Bash
      match: /\b(?:curl|wget)\b[^|;&]*\s-o\s*\S+/
    - tool: Bash
      match: /(?:^|[;&|]\s*)(?:bash|sh)\s+\S+/
tests:
  match:
    -
      - curl -o /tmp/x https://example.com/x.sh
      - bash /tmp/x
  no_match:
    -
      - curl -o /tmp/x https://example.com/x.sh
      - ls /tmp
```

- `window_seconds`: all steps must fall within this time of the first.
- `order`: `strict` means in step order, `any` means in any order.
- `tests` for a sequence rule are lists of steps. A plain string is a Bash step. An object `{tool, content}` names another tool.

Built-in sequence rules cover a credential read followed by an outbound call, a download followed by execution, and injected instructions followed by a tool call.

## Commands

```
pai rules list [--json]
pai rules lint [--json]
pai audit scan [PATH] [--session ID] [--worker ID] [--json]
```

- `pai rules list` shows every rule with severity, source and enabled state. A disabled rule shows as `off`.
- `pai rules lint` runs every rule's fixtures. It exits 1 on a failed fixture or a file that does not load. Run it after you add a rule.
- `pai audit scan` scans the newest session, a given session, a worker, or a transcript file. Findings are grouped by severity and evidence is masked. It exits 1 when a `block` finding hit. Every finished worker is scanned, and `pai worker ps` shows non-zero findings.

## Config keys

None. Rules are files, not settings.

## Worked example

You want a confirmation before anyone runs `terraform destroy`.

1. Create `<PAI home>/rules/terraform-destroy.rule.yaml`:

   ```yaml
   id: terraform-destroy
   severity: confirm
   reason: terraform destroy removes infrastructure
   match: /\bterraform\s+destroy\b/
   tests:
     match:
       - terraform destroy -auto-approve
     no_match:
       - terraform plan
       - echo "terraform destroy"
   ```

2. Run `pai rules lint`. All fixtures pass.
3. Run `pai rules list`. The rule appears with its source.
4. To disable a built-in you find too strict, add a file with the same id and `severity: off` under `<PAI home>/rules`.

## Related

- [Safety and audit in the feature map](../features.md#safety-and-audit)
- [Worker rules](../worker-rules.md)
- [`pai rules`](../commands/rules.md), [`pai audit`](../commands/audit.md)
