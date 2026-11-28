# The worker harness is a CI system

Status: design note, 2026-11-28. Every reference is `file:line` in this tree; anything
without one is **not implemented**.

PAI's worker harness does what Jenkins does: it queues jobs, hands them to a bounded number of
executors, gives each a private workspace, gates the result, keeps history and retries. The
executor is a language model, not a shell script. That one difference shapes everything below.

## 1. Mapping (Jenkins -> PAI)

| Jenkins | PAI | Code |
|---|---|---|
| Build queue | Per-provider ticket queue, fair-ordered across sessions; reorder front/up/to a position; shown in `pai worker ps`, the pane bar and the cockpit | `src/workers/capacity.ts:114` (`queueDir`), `:228` (`fairOrder`), `:339` (`liveQueue`), `:392` (`reorderQueue`), `:436` (`queueRows`), `:703` (`capacityGate`) |
| Review/accept queue | A separate `pai queue` of items to be reviewed and accepted (not the scheduling queue) | `src/workers/queue.ts:229` (state moves), `src/workers/queue-runner.ts:59` (`runQueue`), `src/cli/commands/queue.ts:237` |
| Executors per node | Slots per provider: `maxConcurrent`, local default cap 1, `conversationSlots` reserve one for chat | `src/workers/capacity.ts:34` (`DEFAULT_CAPACITY`), `:52` (`effectiveCap`), `:62` (`admitCap`), `:73` (`providerCap`) |
| Node labels | Providers plus classes/tiers and `--capability`; resolved by `resolveTarget` with an auto order and cooldowns | `src/workers/routing.ts:123` (`autoOrder`), `:281` (`resolveTarget`), `:555` (`capabilityForRun`); `src/workers/config.ts:100` (`WorkerProvider`), `:562` (`classModelCapability`) |
| Job (with parameters) | A worker started from a spec; status file per worker | `src/workers/status.ts` (`WorkerStatus`), `src/workers/specfile.ts`, `src/workers/reroute.ts:511` (`taskText`) |
| Workspace | One git worktree per worker, branch per worker: `git worktree add -B branch dir base` | `src/workers/worktree.ts:400`; pooled/reused slot worktrees `src/workers/slots.ts:38` (`ensureSlotWorktree`), `:55` (`prepareSlot`), `:85` (`releaseSlot`) |
| Pipeline stages | L0 (operator session) starts L1 workers, an L1 starts L2 workers; owner is tracked as spawner session; merges of one repo are batched through a per-repo merge queue with a leader | `src/workers/status.ts` (`spawnerSession`), `src/workers/capacity.ts:201` (`sessionOf`), `src/workers/orchestrate-merge.ts:43` (`joinQueue`), `:115` (`joinRepoQueue`), `:124` (`closeQueue`) |
| Quality gate | Merge gate: verify command, stub and test-loss scans, smoke start; failure reverts and keeps the branch; a pass commits on the checkout and the daemons restart behind a health check | `src/workers/worktree.ts:1170-1182` (gate on the applied diff), `:1188` (`mergeSnapshotWorker`), `:1994` (reapply after failed gate), `:2632` (`saveMergeGateLog`); `src/workers/restart-health.ts`; `src/release/release.ts:46-61` (restart gate around the build); `src/daemon/battery-guard.ts:251` (`SMOKE_LABEL`); flaky-file report `src/cli/commands/worker.ts:850` |
| Build timeout | Progress-based time budget: 20 min of own time, checkpoint without a model call, doubles (20, 40, 80) while there are new edits, commits or passing tests, capped; no progress: stop, salvage the branch, mark "needs review", never auto-fall-through to cloud | `src/workers/time-budget.ts:1-17` (rule), `:69` (`budgetProgress`), `:87` (`nextBudgetMinutes`), `:101` (`budgetCheck`), `:158` (`fireBudget`); manual extend `:143` (`parseExtendMinutes`) |
| Console log / history | `pai worker replay <id>` from recorded events; `follow`, `log`, `ps`; panes; a ledger file of lifecycle lines | `src/cli/commands/worker.ts:725` (`replayCommand`), `src/workers/viewer.ts:389` (`replayOutput`), `src/workers/ledger.ts:58` (`appendLedger`), `:87` (`ledgerSummary`), `src/workers/pane.ts` |
| Retry / rebuild | Resume (previous-run summary as context), reroute to another provider, fall-through (new worker continues the branch, origin marked superseded), escalate a tier | `src/workers/resume-args.ts:76` (`previousRunSummary`), `src/workers/reroute.ts:549` (`rerouteWorker`), `:140` (`FALLTHROUGH_RECENT_MS`), `:172` (`endOriginContinued`), `src/workers/lineage.ts:12`, `:33` (`markSuperseded`), `src/workers/escalation.ts:129` (`detectTrigger`), `:167` (`decideEscalation`) |
| Build-agent health | Endpoint probes per instance, restart health | `src/workers/capacity.ts:91` (`instanceUp`), `src/workers/endpoint-health.ts` |

## 2. Where it differs

**The executor judges and errs.** A Jenkins step either exits 0 or not. A worker can run for
an hour, loop, thrash on failing commands, or finish with a wrong answer. So the harness
supervises the job itself:

- Stall/thrash/loop/sleep detection pushes one-line events to the owning session:
  `src/workers/supervision.ts:99` (`SupervisionKind`), threshold `:198`
  (`DEFAULT_STALL_MINUTES = 10`).
- Escalation triggers (context fraction, repeated failures) pick a higher tier:
  `src/workers/escalation.ts:69` (`DEFAULT_ESCALATE`), `src/workers/reroute.ts:67`
  (`escalationReason`).
- The merge gate exists because the result is not trusted (section 1).

**Several executors share one GPU.** A local model serves one request stream, so "3 slots"
means 3 workers in line at one engine, not 3 CPUs. Consequences in code:

- Time in line at the model is not the job's time. The deadline subtracts build-gate waits,
  router-queue waits, preemption pauses, freeze time and system sleep:
  `src/workers/active-time.ts:56`, `:99`, `:107`, `:117` (`blockedMsOf`).
- Start-up is staggered, with learned warm-up limits: `src/workers/stagger.ts:64`
  (`warmupLimitSec`), `:94` (`findPredecessor`).
- Engine-idle and GPU sampling decide whether to admit an extra worker:
  `src/workers/capacity.ts:696` (`engineIdleFor`), `src/workers/local-idle.ts:125-162`
  (GPU utilisation window and sampler).

**Slot lending.** A worker waiting on a long Bash tool call does not use the model. After
20 s (`src/workers/status.ts:1302`, `DEFAULT_TOOL_LEND_MS`) `slotLent` (`:1315`) is true,
`holdsSlot` (`:1308`) stops counting it, and the next queued worker is admitted. On return the
worker queues for its slot back: `src/workers/tool-wait.ts:16` (`markToolWait`), `:26`
(`returnFromToolWait`), `src/workers/capacity.ts:888` (`waitsForSlotBack`), `:896`
(`slotBackPosition`). Jenkins has no equivalent because a shell step holds its executor.

**Gatekeeper for expensive executors.** Cloud providers cost money, local ones do not.
Local-only mode blocks cloud starts and reroutes unless the gatekeeper session approves with
a time-limited approval: `src/workers/local-only.ts:44` (`GATEKEEPER_KEY`), `:105`
(`isGatekeeperSession`), `:128` (`addApproval`), `:138` (`consumeApproval`), `:215`
(`localOnlyStartCheck`), `:275` (`localOnlyRerouteCheck`). Provider budget walls and
cooldowns skip providers near their limit: `src/workers/budget.ts:167` (`budgetWall`),
`:193` (`budgetFull`), `src/workers/routing.ts:62` (`BUDGET_COOLDOWN_MIN`), `:171`
(`recordBudgetCooldowns`). The time-budget path deliberately never falls through to the
cloud by itself (`time-budget.ts:12-14`).

## 3. What to borrow

**Agent/controller split.** Jenkins runs one agent per machine; a controller aggregates and
dispatches. Today everything is one machine: queue tickets, status files and the ledger are
files under the local log dir (`capacity.ts:114`, `status.ts`, `ledger.ts`), worktrees are
local paths. A multi-machine PAI should keep that per-machine queue as the agent, and add:

- A controller view that merges the per-machine queues and dispatches by label. Not
  implemented; the cockpit reads one machine's files.
- Explicit machine identity in worker status (`WorkerStatus` has no host field; not
  implemented), so `ps`, replay and the ledger can say where a job ran.
- Shared state in the database, not local files. The storage layer already abstracts a
  Postgres backend (`docs/design/postgres-only.md`), but worker status, queue tickets and
  the ledger do not use it. Not implemented.

**Labels instead of provider names.** Routing resolves provider names, classes and one
capability (`routing.ts:555`, `config.ts:562`). Jenkins jobs say `label: gpu`, not
`node: build-07`. Labels such as `local`, `vision`, `large-context` should be attributes of
a provider/instance so a job asks for properties and the router picks any matching executor,
on any machine.

**Build history as a first-class view.** `replay` and `ps` are per worker id; the ledger is
a flat file. Jenkins shows a job's history across builds. The data exists: lineage links
reruns and fall-throughs (`lineage.ts:12`) and sessions own workers (`capacity.ts:201`),
but there is no per-topic or per-session history view.

**Throttling per category.** Caps are per provider (`providerCap`) and queue order is fair
across sessions (`fairOrder`, `capacity.ts:228`), but there is no cap per session or topic
(like Jenkins' throttle-concurrent-builds categories).

## 4. Ranked gaps

1. **Machine identity and aggregate view (absent).** Add a `host` field to worker status
   and ledger lines, and make `ps`/cockpit show it. This is the cheapest prerequisite for
   everything multi-machine and changes no scheduling. Then a read-only controller that
   merges the queue rows (`capacity.ts:436`) of several machines.
2. **Shared state in the database (absent for workers).** Move worker status, queue tickets
   and ledger behind the existing storage interface so any machine can read them.
   Queue tickets are the hard part: they rely on pid liveness (`liveQueue` takes `isAlive`)
   which is meaningless across machines; replace by lease/heartbeat rows.
3. **Labels (partial).** Capability and class routing exist. Add free-form labels on
   providers/instances in config and a `--label` selector in `resolveTarget`; keep the
   provider name as a pin. Prerequisite for dispatch by a controller.
4. **Per-session/topic throttling (absent).** Add an optional cap per session key and per
   topic on top of `fairOrder`, enforced in `capacityGate` (`capacity.ts:703`), so one noisy
   session cannot fill a provider. Fair ordering already prevents starvation but not
   occupation.
5. **History view per topic/session (partial).** Data exists (status files, lineage,
   ledger). Add `pai worker history --session|--topic` that groups workers with their
   reruns, outcomes, gate results (`saveMergeGateLog`, `worktree.ts:2632`) and durations.
6. **Cross-machine worktrees and merge (absent).** Worktrees are local and the merge gate
   applies to the checkout on one machine. A remote agent would push its worker branch to
   the forge and the controller's machine would run the gate. Only worth doing after 1-3;
   the existing branch-per-worker model (`worktree.ts:400`) already makes the branch the
   unit of transfer.
