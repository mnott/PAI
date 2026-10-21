# Routing policy

Skip this page if you only use the `anthropic` provider.

The [tier table](delegation-tiers.md) says which models a tier may use. The
routing policy decides, per run, whether local or cloud is tried first, and what
happens when a provider is out of budget.

## Policy modes

With no policy set, the tier lists are used as written.

```
pai worker policy                     # show the policy and the route the next run takes
pai worker policy prefer-local --for 2h
pai worker policy clear               # remove it
```

| Mode | Meaning |
|---|---|
| `cloud-only` | Never local (battery, on the road). |
| `local-only` | Never cloud; fails if no local server answers. |
| `prefer-local` | Local first; a local run with a bad [report](workers.md#the-report) is repeated once on the cloud. |
| `prefer-cloud` | Cloud first; local only when the cloud is unavailable. |
| `auto` | Like `prefer-local`, but cloud on battery and for an `--urgent` run. |

`--for DURATION` (`30m`, `2h`, `1d`) expires the policy. The policy
is kept in a state file (`routing-policy.json`) in the PAI home's worker log
directory, not in `workers.yaml`; `pai worker policy clear` removes it and routing
returns to the tier lists. It changes the t2 list the next run reads (see `pai worker route`).

## Per-run flags

| Flag | Effect |
|---|---|
| `--local` | Run on the running local model; never name a local provider. |
| `--cloud` | This run goes to the cloud under `prefer-local` or `auto`. |
| `--local-ok` | This run may go local under `prefer-cloud`. |
| `--urgent` | Fast answer needed: cloud even when the policy prefers local. |
| `--where local\|cloud\|NAME` | Where to run; `local` and `cloud` are resolved by PAI. |
| `--force-local` | With `--where local`: stay local even if the route classifier sends it to the cloud. |
| `--provider NAME` | Beats the policy. |

## Budget walls and fallback

Auto routing walks providers under `workers.routing`:

| Key | Default | Meaning |
|---|---|---|
| `policy` | `budget` | `budget` skips providers at their wall; `order` walks `routing.order` verbatim. |
| `order` | `[]` | Provider names in preference order. |
| `priority` | `[]` | Preference order for `budget`; empty falls back to `order`, then `budgetPriority`. |
| `budgetPriority` | `[anthropic, glm, kimi]` | Walked when `priority` and `order` are empty. |
| `budgetPercent` | anthropic 95, glm 90, kimi 85 | Percent used at which a provider counts as full. |
| `budgetWalls` | `{}` | Per-provider override of `budgetPercent`. |
| `budgetWall` | `95` | Wall for a provider neither map names. |
| `cooldownMinutes` | `30` | Minutes a provider rests after a quota or rate failure. |
| `retryOnQuota` | `true` | Reroute a run that failed before its first tool to the next provider. |

When the Anthropic budget is out, the tier lists do the work: the t0 list moves
from `anthropic/opus` to `glm/glm-5.3`. To move every new Claude Code process on
the machine, use `pai worker fallback on [PROVIDER]` (`off` restores). This changes all new Claude Code sessions, not only workers; undo with `off`.

After two failed local attempts on the same `--label`, the next start goes to the
cloud and says so; `--force-local` turns that off.
