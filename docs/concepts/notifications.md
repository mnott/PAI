# Notifications: session and PAILot

PAI tells you about runs in two places, and they have different rules.

## The session

Automatic notices go **to the session that started the work**: a plan unit that
finished, queue items that are ready, a worker in trouble. They arrive as a
message into that conversation, so Claude wakes up and can talk to you about it.
You never have to poll.

- **Run reports** (plan and queue runs): finished units are grouped, and ready
  queue items are batched.
- **Worker trouble** (`TroubleWatcher`): guard denials past a threshold, a worker
  that has gone quiet, a hard stop. The hard stop is always sent.

## PAILot

**Automatic notices never go to PAILot.** PAILot, the phone app, is for replies
to what you asked: a conversation you started there gets its answers there. A
background plan finishing is not a conversation.

Anything that does reach PAILot passes one gate, so a bug cannot flood your
phone: the same text is sent at most once per `dedupHours` (the marker is
persisted, so a restart does not repeat it), and no more than `maxPerMinute`
messages leave per window from all PAI processes. The excess is dropped, one
summary line per window is sent, and the ledger records `PAILOT-RATE-LIMIT`.

## Keys under `notices`

Set them in your `config.yaml`; `pai config get notices.pailot.maxPerMinute
--source` shows where a value comes from.

| Key | Default | Meaning |
|---|---|---|
| `notices.pailot.maxPerMinute` | `5` | Messages that may leave per window. |
| `notices.pailot.dedupHours` | `24` | How long a sent text counts as a duplicate. |
| `notices.pailot.windowSecs` | `60` | The rate window. |
| `notices.runReports.planGroupThrottleMinutes` | `15` | At most one grouped unit-done message per span. |
| `notices.runReports.queueReadyBatchMinutes` | `10` | Ready queue items batch into one message per span. |
| `notices.trouble.throttleMinutes` | `5` | At most one trouble message per worker per span; hard stops bypass. |
| `notices.trouble.denialWindowMinutes` | `10` | Window in which denials count. |
| `notices.trouble.denialThreshold` | `3` | Denials in the window before the session is told. |
| `notices.trouble.stallMinutes` | `10` | Silence while running before the session is told, once per quiet spell. |

## Other channels

The `notifications` section of `config.yaml` (mode and channels such as ntfy) is
a separate subsystem and is not covered here.

Related: [loop guard and limits](loop-guard-and-limits.md) for what counts as a
denial, [panes](panes.md) for the auditor, which writes to the ledger only.
