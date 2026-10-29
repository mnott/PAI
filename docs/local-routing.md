# Local routing and the local worker contract

Which model serves a run is decided by the [route table](concepts/delegation-tiers.md) and the [routing policy](concepts/routing-policy.md) (`pai worker policy`, `--local`, `--cloud`, `--urgent`). This page covers what the policy does not: the classifier that keeps unsuitable tasks off a local model, and the rules a local worker gets. Local models themselves: [local models](concepts/local-models.md).

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

After 2 failed local attempts (`LOCAL_FAILURE_LIMIT` in `src/workers/route-classifier.ts`; rc != 0, deadline, loop-stop, kill) on the same `--label`, the next `pai worker run` with that label goes to the cloud automatically and says so (`route: cloud (escalated: 2 failed local attempts)`). The count comes from the routing ledger (WORKER-END lines of local providers); a success resets it. This applies only when no `--provider`, `--where`, `--local`, `--cloud` or `--local-ok` is given. `--force-local` turns it off.

The plan runner and the queue apply the same limit in their own way: see [plan-runner.md](plan-runner.md#failure-ladder) and [queue.md](queue.md#states). The whole escalation picture is in [escalation](concepts/escalation.md).

## Local worker contract

Every headless worker that runs on a local provider (never a cloud one) gets a short rule block in front of its task: type-check first, run only the touched test class, read files whole with the Read tool, stop after the first red test and report, never repeat a failing command unchanged.

## `.pai/checks.yaml`

Optional, at the project root. Names the project's fast commands so the contract can point at them:

```yaml
fast: npx tsc --noEmit            # type-check / lint, seconds
test_one: npx vitest run {class}  # run one test class; {class} is the touched class
tests: operator                   # the operator runs the tests: the contract names none
```

`tests: operator` enforces the operator-tests loop in the harness, not just in the contract: the worker Bash guard denies every test command (vitest/jest/pytest/`npm test`/`go test`/`cargo test`/`swift test`, `xcodebuild … test`, `tools/check.sh`, and a registered build door invoked in a test mode such as `sh tools/build.sh test mac --wait`). The worker builds the touched target, reports, stops. `pai worker run --allow-tests` opts one run back in (`PAI_WORKER_ALLOW_TESTS=1`) — use it only when the operator asked for tests.

Missing file: the contract names no commands.
