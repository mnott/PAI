# Three-tier coding: cloud plans, local models write the code

PAI runs a large coding job over three delegation tiers, so most tokens are spent
on a model on your own machine and the cloud is used for what only it does well.
The tiers, their model lists and the class-to-tier mapping are described in
[concepts/delegation-tiers.md](concepts/delegation-tiers.md):

| Tier | Name | Job | Models, first available serves |
|---|---|---|---|
| `t0` | Session | You talk to it | `anthropic/opus`, then `glm/glm-5.3` |
| `t1` | Orchestrator | Splits, plans, reviews | `anthropic/sonnet`, then `glm/glm-5.3-flash` |
| `t2` | Worker | Implements the parts | `local`, then `anthropic/sonnet`, then `glm/glm-5.3-flash` |

`pai worker route` prints the live table. When work does not fit a tier, see
[concepts/escalation.md](concepts/escalation.md). This page keeps the mechanisms
around a unit run and the cockpit.

## How a unit runs

1. The session writes a brief for the unit and starts `pai worker run --orchestrate`.
2. The orchestrator splits the unit into parts of a few files each and writes one spec per part: root cause or
   requirement, exact files, the proof it expects, "commit on your branch".
3. Each part runs as a `--class implement` worker in its own worktree. Parts are **pipelined**: the next part's spec is
   written and started while the previous one is in review.
4. The orchestrator reviews the diff and merges with the gate:
   `pai worker merge <id> --verify "npx tsc --noEmit && npx vitest run --retry=2"`. A failing gate reverts the merge and
   keeps the branch; a merge that removes test cases is rejected.
5. At the unit end the session runs its own checks and starts the next unit.

A stuck implementer asks a stronger model for one bounded sub-task with `pai worker help`
(see [Asking for help](#asking-for-help)).

## Mechanisms, not instructions

Instructions in a prompt wear off; every rule that matters is enforced by the CLI or a hook.

### Guards

- **Loop guard** (PreToolUse, workers only). Counts identical tool calls since the last edit, for every tool: Bash commands
  as written, test runs by runner and target files (flag variants such as `--run` or `--no-isolate` count as the same run),
  `Read` by file and range, other tools by their input. The 5th identical call is denied with the reason; after three
  denials of the same call the session is stopped with a loop event that the orchestrator sees in `pai worker wait` and
  `pai worker ps`.
- **Orchestrator edit guard.** An `--orchestrate` worker cannot edit code, including in-place edits through `sed -i` or
  `perl -i`; scripts and heredoc bodies are treated as data, only real targets count.
- **Delete guard.** Workers do not delete files themselves; they list them as `delete:` entries in their report and the
  orchestrator decides.
- **Live config isolation.** Workers get a private copy of the worker configuration; they never write the live one.

### Time limits

- **`pai worker wait-on PID --log FILE`** waits for a detached job (a build, a test run) with a ceiling of 30 minutes from
  the process start and a stall rule (no log output for 5 minutes). Either one kills the whole process tree and exits 4.
  A synchronous infinite loop in a test, which the test runner's own timeout cannot interrupt, ends there.
- **Orphan reaper** (daemon, `workers.reaper`, on by default). Every 30 s it kills processes left behind by workers:
  reparented to launchd, older than 2 minutes, above 50 % CPU in two samples. A Bash tool timeout kills the shell but not a
  forked test runner; the reaper ends those and notes the kill on the owning worker.
- **Client timeouts for local providers.** Workers on loopback providers get 30-minute request and stream-idle timeouts;
  a long tool call from a local model can be silent for minutes while it is generated.

### Local provider settings

For a non-Anthropic provider the worker settings keep the provider's output cap (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`), drop
first-party-only flags and turn thinking off unless the provider sets `thinking: on`. Set
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` to the context the server actually serves, so compaction triggers before the server
overflows.

The server side needs matching limits: a request timeout of at least 30 minutes, the model's native context length and a
prefix cache. With hybrid attention models (linear-attention or state-space layers) check that an identical repeated prompt
hits the prefix cache; a retry that misses re-reads the whole prompt.

### Talking to a running worker

- `pai worker goal <id> "<text>"` records a note that the worker receives after its next tool call.
- `pai worker kill <id>` ends a worker and its whole tree.

### Asking for help

`pai worker help --task "<one paragraph>" --files a.ts,b.ts` runs a bounded sub-worker (20 minutes at most) on a stronger
provider, in place, and prints its report and changed files. Each orchestrated unit has a budget of help calls (default 2,
`PAI_HELP_BUDGET`); past it the verb exits 4 and the worker reports the blocker instead. `pai worker help --report` lists
every call.

### Pool slots

With `pai worker pool on`, small runs talk to long-lived headless slots so the provider's prompt cache carries over between
runs. Each provider and model has its own slot settings file, and a slot knows which job it is serving, so goal notes,
guards and the help budget work inside pooled runs as they do in standalone ones.

## Small incremental changes

Not every request is a planned job. A one-sentence fix ("the tooltip says Sav", "move this button") needs no plan and no
cloud tier: `pai queue add` it, `pai queue run` lets a local worker do each in its own worktree branch, and
`pai queue review` shows the results as a batch to accept, reject or send back with a note. Anything over the size limit
becomes too-big, and items still wrong after two rounds go to Sonnet. See [queue.md](queue.md).

## Watching it

```
pai worker ps                 # running and recent workers, what each is doing now
pai worker follow [ID]        # live transcript
pai worker errors             # tool errors, classified harness / model / unknown
pai worker usage              # tokens per worker and provider
pai worker pending            # finished branches not merged yet
```

### The cockpit

The router serves a cockpit page at `http://127.0.0.1:8790/cockpit`. It reads the router's usage log and the worker status
files and shows, for a chosen window:

![The PAI router cockpit: cloud limits, local model status, system load and power, worker pool, tokens and cache hit ratio per provider, speed per model](images/cockpit-limits-routing.jpg)


- **Cloud** and **Local** totals, **Providers**, **Speed per model**;
- **Tokens per bucket by kind** and **Tokens per day per model** (last 14 days);
- **Cache hit ratio**, **Local prefix cache** and **Cache verdict by pause** (whether the prompt cache survived a pause);
- **Sessions by tokens** and **Worker runs**;
- **Worker pool** (slots, tasks served, cache carried over);
- **System** — memory, load, temperature, power, GPU/CPU load.

To open it from another device on your tailnet, set `router.bind` to `tailscale` (or an explicit address) in the main
config. The router then opens a second listener on that address; the cockpit needs the token from
`~/.pai/router-cockpit.token` (as `?token=`, a Bearer header, or the cookie the first token hit sets), and the `/v1`
model route stays limited to loopback and the tailnet. A wildcard bind is refused.

## How it looks to you

You do not poll and you do not run commands. A plan or queue run is started detached by the session you are talking to; it keeps going if that session ends, and it speaks up in that conversation when something needs you: a part that failed twice (needs-decision), a run that is blocked, a failed unit check, a unit group finished (at most every 15 minutes), the run's end with its wall time, parts, escalations and cloud tokens, and, for queues, the ready items (at most every 10 minutes, in plain words). Blocked and finished runs also reach PAILot as one short sentence. The session answers you in plain words and asks for the decision it needs.

## What to expect

On a 38-unit refactoring job (a CLI framework migration with about 900 new tests), a local 80B mixture-of-experts model
as tier 2 matched the cloud-only run on quality: every unit merged through the gate, the full suite stayed green, behaviour
parity was 97 %. That first run took about twice as long as the cloud-only run (5 h vs 2.5 h, both with one implementer at
a time), and a slow local tier made the cloud orchestration more expensive, because the orchestrator waits and re-reads
while the local slot works. It ran before most of the mechanisms on this page existed: no loop guard for the first hours,
no time limits or orphan reaper, a context window at half the model's native length for the first units, and parts started
one after the other instead of pipelined until the third unit. The levers that matter most are the ones above: pipelined
parts, fixed part size, the loop guard and the time limits, and enough local slots for the parts that can run in parallel.

See also: [worker-providers.md](worker-providers.md) · [router.md](router.md) · [worker-denials.md](worker-denials.md) ·
[commands/worker.md](commands/worker.md)
