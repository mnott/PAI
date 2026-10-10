# `.pai/project.yaml`: the status sink

Where the session handover (the `## Continue` section) goes.

## What it does

- `sink: todo` (default, also without the file): the handover lives in
  `Notes/TODO.md`.
- `sink: forge`: the handover is written into a forge issue instead, in the
  section `<!-- pai:continue --> ... <!-- /pai:continue -->` (replaced, or
  appended when absent; the rest of the issue is left byte-identical). PAI never
  comments and never closes.

```yaml
status:
  sink: forge
  forge:
    anchor: 283                      # issue number of the anchor
    marker: MYPROJECT-HANDOVER-V1    # must occur in the anchor body
    repo: OWNER/NAME                 # optional; default from `git remote get-url origin`
```

**Anchor and marker.** The anchor is a long-lived issue whose body contains the
marker and names the current handover issue with a line `handover: #<n>`; without
that line the first `#<n>` after the marker is used. The marker guards against
writing through a wrong issue number.

**Token.** Config `forge.token` (`pai config set forge.token <token>`), else env
`FORGE_TOKEN`, else `AIBROKER_FORGE_TOKEN`. Never printed.

Session notes are unaffected: they are written as before whatever the sink.
The whole forge write has a 5 s budget; on failure the handover stays in
`Notes/TODO.md`.

## Set up for a project

```
pai project init                                   # sink forge for a non-GitHub origin, todo for github.com or none
pai project init --force --anchor 283 --marker MYPROJECT-HANDOVER-V1
```

`init` never searches issues for an anchor; you pass it.

## See it working

`pai project health` in the project: `ok - forge token present; anchor #283
reachable, marker matches`.

## Troubleshooting

| Line | Fix |
|------|-----|
| `missing - forge token present` | `pai config set forge.token <token>` |
| `missing - forge anchor and marker set` | `pai project init --force --anchor <issue> --marker <text>` |
| `anchor #N lacks marker` / `HTTP 404` | Wrong number or marker; same command with the right values |
| `.pai/project.yaml is not valid YAML` | `pai project init --force` |

Keep `.pai/project.yaml` out of public repos if the anchor is private.
