# Tenants: customer-owned rules and audit export

A tenant is a customer (or team) that owns its rules and the record of when they fired. PAI evaluates every
decision against the rule set of the tenant it belongs to, and writes the tenant into every audit line.

## The default tenant

`local` is built in: the shipped `antipatterns/` plus your own overrides in `~/.pai`. Nothing changes for you unless
you configure another tenant.

## Set up a customer rules directory

1. Make a directory the customer owns, typically a git repo, in the same layout as the shipped `antipatterns/`:

   ```
   acme-rules/
     shell/<id>.yaml        shell rules (rule schema: severity, match, reason)
     tool-loop/<id>.yaml    loop detectors
     final-text/<id>.yaml
     paths/<id>.yaml
   ```

2. Register it in the main config (`~/.pai/config.yaml`):

   ```yaml
   tenants:
     acme:
       description: Acme Corp
       rulesDir: /srv/acme-rules      # absolute path
       projects: [/srv/acme-work]     # optional: hook sessions under these paths belong to acme
   ```

3. A tenant's rule set is the shipped set overlaid by its `rulesDir`: the same `id` wins over the shipped rule.
   A tenant may

   - add a rule (a new id),
   - re-mode a shipped rule: copy its file and set `mode: monitor` (record only) or `mode: enforce`,
   - change `severity` of a shell rule, or add exceptions and `per_model` tuning,
   - retire a rule: `status: retired` (same as `deprecated`) or, for a shell rule, `severity: off`.

   Files are re-read when their mtime changes; no restart is needed.

## Which tenant a decision belongs to

| Caller | Tenant |
| --- | --- |
| UHP bearer token | the token's tenant: `pai uhp token create --tenant acme` (default `local`) |
| Router/proxy request with a worker run token | the tenant of the run, taken from the run's project at start |
| Hook in an interactive session | the tenant whose `projects` contain the session's cwd, else `local` |

Rules are evaluated by one decision API for all of them, so a tenant's rules apply the same way in hooks, the loop
guard and the model-API proxy. The MCP server is advisory: it cannot veto other tools.

## Audit export

Every firing (a rule noted, denied, stopped, continued or recorded in monitor mode) is a line in
`~/.pai/antipatterns/firings.jsonl`; how a run ended after it is a line in `outcomes.jsonl`. Each new line carries:

| Field | Meaning |
| --- | --- |
| `tenant` | the tenant whose rule set decided |
| `ruleId`, `ruleVersion` | the rule and a hash of its file content (changes whenever the file changes) |
| `principal` | token id, `run:<id>` or `session:<id>`; never a secret |
| `source` | `hook`, `proxy`, `mcp` or `uhp` |

Lines written before tenants existed have no tenant and are exported under `local`.

```
pai audit export --tenant acme [--since 2026-10-01T00:00:00Z] [--until <iso>] [--format jsonl|csv] [--out acme.jsonl]
```

Without `--out` the export goes to stdout and the manifest to stderr; with `--out` the manifest is written to
`<file>.manifest.json`. The MCP tool `audit_export` takes the same arguments and returns both.

The manifest holds the tenant and window, the export time, the PAI version, the line counts, `rulesFired` (each rule id
with the content versions that fired in the window), `ruleSet` (every rule id and version active for the tenant at
export time) and `sha256` of the export body, so the customer can show the file was not altered after export.

Export is read-only: it never modifies or deletes the logs.
