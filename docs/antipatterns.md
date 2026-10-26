# Anti-pattern directory

One directory of known bad behaviour that ships with PAI and grows in your environment.

```
<package>/antipatterns/<category>/<id>.yaml    shipped, versioned with PAI
$PAI_HOME/antipatterns/<category>/<id>.yaml    your own
$PAI_HOME/antipatterns/_candidates/            auto-caught cases, inactive
```

Categories: `shell` (command rules), `tool-loop` (repeated tool calls), `final-text` (a worker's final answer), `paths` (file paths).

Every pattern has a `layer` (defaults from the category):

| layer | what | per model |
|---|---|---|
| `baseline` | security and environment (shell rules, path rules) | no: always as configured; `applies_to` is ignored |
| `behaviour` | loop patterns (identical-write, revert, distinct-rewrites, repeated-failure, growing-command, runaway-new-files, missing-path-streak, unparsed-tool-call) | the same rule for all models; `per_model` tunes thresholds and mode |
| `quirk` | observed for specific models only (`mangled-var-folders-path`, Gyro family) | enforce for the models in `applies_to`, monitor for the rest |

Outside a behaviour/quirk rule's `applies_to` a firing is recorded only (monitor). A `per_model` block (`per_model: { "<id or glob with *>": { mode?, params? } }`) overrides mode and detector params for one model at evaluation time; the first matching entry wins, an exact id beats a glob. A user override's `per_model` entry replaces the shipped entry for the same key. See [Lifecycle and layers](concepts/security-rules.md#layers).

## Override rules

- The same `id` in your directory replaces the shipped pattern completely (thresholds, regexes and message); a new `id` adds one.
- A file that fails validation is skipped with one `pai: antipattern <file> skipped: <reason>` line on stderr. It never stops a hook or a worker, and the shipped pattern stays active.
- The directory is re-read when a file's mtime changes: edits take effect without a restart.
- `_candidates/` is never read.
- Shipped patterns are embedded into the hook bundles at build time (`scripts/gen-builtin-rules.mjs`, run by `npm run build`); run it after editing a file under `antipatterns/`.

## Schema (non-shell categories)

```yaml
id: identical-write            # lowercase letters, digits, dashes; unique
category: tool-loop            # must match the directory
detector:
  kind: identical-write        # one of the kinds below
  params: { note_at: 2, stop_at: 20, stop_message: "..." }
action: note                   # note | deny | continue | stop
message: "{file} already contains ..."   # sent to the model; {placeholders} filled by the detector
tests:
  match: ["A A"]               # samples the detector must fire on
  no_match: ["A B"]            # samples it must not fire on
provenance: { date: 2026-10-25, model: claude-sonnet-5-5, observed: "what happened", ref: "commit or issue" }
```

Provenance holds model names, dates and a reference only: no paths, no user names.

| category | kind | params | message placeholders | sample format in `tests` |
|---|---|---|---|---|
| tool-loop | `identical-write` | `note_at`, `stop_at`, `stop_message` | `file`, `tool`, `n` | Write contents separated by spaces, one file |
| tool-loop | `revert` | `note_at`, `stop_at`, `seen_cap`, `stop_message` | `file`, `ordinal`, `n` | Write contents separated by spaces, one file |
| tool-loop | `growing-command` | `max_repeats`, `stop_denials`, `note_message`, `tool_message` | `count`, `tool` | Bash commands, one per line, identical output |
| tool-loop | `repeated-failure` | `deny_at`, `stop_at` | `key`, `deny_at`, `hang`, `echo` | runner commands, one per line, no edits |
| final-text | `unparsed-tool-call` | `regexes` (group 1 = tool name), `tail_chars`, `json_window_lines` | `name`, `allowed` | the final text |
| paths | `missing-path` | none | `path`, `near` | a path |

Detector code stays in TypeScript and reads these values on every call; `action: stop` ends the session, `continue` re-prompts the worker once.

## Shell patterns

`shell/<id>.yaml` keep the rule schema documented in `docs/concepts/security-rules.md` (`match`, `severity`, `reason`, `tests`, ...). They are embedded in `builtin.generated.ts` at build time; your own go in `$PAI_HOME/antipatterns/shell/<id>.yaml` (loaded after `$PAI_HOME/rules`, same id replaces).

## Adding one

1. Write `antipatterns/<category>/<id>.yaml` (shipped) or `$PAI_HOME/antipatterns/<category>/<id>.yaml` (yours) with at least one `match` and one `no_match` sample.
2. Shipped: `node scripts/gen-builtin-rules.mjs`, then `the sample check in the antipatterns generator`; the test runs every file's own samples through its detector.
3. A new detector kind needs code: register its parameter check in `src/hooks/ts/lib/antipatterns.ts` and a sample adapter in `antipatterns.test.ts`.
