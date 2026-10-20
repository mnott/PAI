# Local routing and the local worker contract

## Route classifier

When a run targets a local model (`--where local`, MCP `where: "local"`, a local-first session profile, a plan whose provider is `local`), PAI first decides whether the task belongs there. The rules are deterministic and the decision is printed and logged: `route: cloud (install/device task)`. MCP delegation tools return the same reason at the start of their result.

| Signal | Cloud | Local |
|---|---|---|
| plan part `kind:` | infra, install, device, external, redesign | code, test |
| worker label / tags | contains one of the cloud kinds as a word | |
| task text | install, signing, App Store, TestFlight, notarize, device, iCloud, CloudKit, build system, door, CI, release, migrate, redesign, refactor across modules | everything else |

`kind:` is an optional field of a plan part (`pai plan` validates it).

Override: `--where local --force-local` (CLI), `force_local: true` (MCP), `pai plan run --force-local`.

## Escalation

After 2 failed local attempts (rc != 0, deadline, loop-stop, kill) on the same label, the next start goes to the cloud automatically and says so (`route: cloud (escalated: 2 failed local attempts)`). `pai worker run --label X` counts them from the routing ledger (WORKER-END lines of local providers; a success resets). The plan runner does the same per part: two local attempts, then one cloud (Sonnet) attempt, with or without `--escalate`. `--force-local` disables it.

## Local worker contract

Every headless worker that runs on a local provider (never a cloud one) gets a short rule block in front of its task: type-check first, run only the touched test class, read files whole with the Read tool, stop after the first red test and report, never repeat a failing command unchanged.

## `.pai/checks.yaml`

Optional, at the project root. Names the project's fast commands so the contract can point at them:

```yaml
fast: npx tsc --noEmit            # type-check / lint, seconds
test_one: npx vitest run {class}  # run one test class; {class} is the touched class
```

Missing file: the contract names no commands.
