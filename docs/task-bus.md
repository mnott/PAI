# Task bus — using a tracker as an input channel

File a task from your phone. A session picks it up, does the work, and ticks it off.

This document is the setup guide. For why the design splits the way it does, see
`Notes/docs/task-bus.md`.

---

## Two paths, and they are not the same feature

Tasks can reach a session two ways. They have very different setup costs, and
only one of them carries comments.

| | **Path 1 — PAI polls** | **Path 2 — webhooks** |
|---|---|---|
| Who runs it | PAI (`src/tasks/poller.ts`), launchd | AIBroker receiver |
| Latency | One poll interval | Immediate |
| New tasks | yes | yes |
| **Comments on a task** | **no** | **yes** |
| **Reminders (`reminder:fired`)** | **no** | **yes** |
| Needs a public HTTPS endpoint | no | yes |
| Needs an OAuth grant | no | yes |
| Platform | any | macOS + iTerm2 |

Path 2 is a strict superset in capability **and** in setup cost. Start with
path 1; add path 2 when you want to talk back to a task rather than only file
one.

The distinction that matters most: **a comment is how you correct work already
dispatched** — "no, do it this way instead". On path 1 that correction is
silently dropped, because nothing is subscribed to it. If you intend to have a
conversation with a task, you need path 2.

Scheduling note: **due dates push nothing.** Only reminders fire. A task due
Tuesday sits there; a task with a reminder for Tuesday arrives. This is why path
2 needs no timer anywhere.

---

## Path 1 — PAI polls

### 1. Get a Todoist API token

Todoist → Settings → Integrations → Developer → API token.

### 2. Configure

In `~/.config/pai/config.json`:

```jsonc
{
  "tasks": {
    "enabled": true,
    "autoDispatch": true,        // false = report ownership, do not dispatch
    "providers": {
      "todoist": {
        "enabled": true,
        "apiKey": "<your API token>",
        "rootProjectId": "<id of the parent project holding your session projects>",
        "findingsSectionId": "<id of the section where findings are filed>"
      }
    }
  }
}
```

`rootProjectId` is the **parent** project. Each session that should own work gets
a sub-project under it, named after the session:

```
Claude 🤖              ← rootProjectId
├── PAI
├── AIBroker
├── Jobs Matthias
└── Jobs Grazyna
```

Ownership is the sub-project a task sits in. Filing from a phone is then one
project pick rather than remembering a label.

Never resolve a project by name-search at dispatch time — record the id. Two
projects can share a name, and the search will not tell you.

### 3. Install the schedule

```sh
pai task schedule install     # launchd, StartInterval
pai task schedule status
```

A tick with nothing to do costs one API call and no tokens — it carries no LLM.

### 4. Check it

```sh
pai task list                 # what the bus can see
pai task dispatch --dry-run   # who would receive what
pai task poll                 # run one tick by hand
```

### Without AIBroker

Path 1 degrades rather than breaking. With AIBroker, PAI dispatches and spawns
sessions. Without it, PAI reports:

```
3 tasks belong to BirnPartners — run `pai birnpartners`
```

Same feature, you do the routing. This is deliberate: PAI ships cross-platform,
AIBroker is macOS + iTerm2, and putting the task logic in AIBroker would make
this degradation impossible.

---

## Path 2 — webhooks

Owned by AIBroker. **The procedure lives in AIBroker's `docs/todoist.md`** and is
maintained there; it is not duplicated here, because a copied procedure drifts.

What you will need:

- A **public HTTPS endpoint on port 443** terminating TLS and forwarding to the
  receiver on `127.0.0.1:8766`. Tailscale Funnel, Cloudflare Tunnel, or Caddy on
  a real domain all work.
- A Todoist app in the **App Management** console, with a client id and secret.
- Event subscriptions — at minimum `item:added`, `item:completed`,
  `note:added`, `reminder:fired`.
- `TODOIST_CLIENT_SECRET`, `TODOIST_CLIENT_ID`, `TODOIST_INGRESS_PROJECTS` and
  `TODOIST_DEFAULT_OWNER` in `~/.aibroker/env`.
- **An OAuth grant, completed per user** — `aibroker todoist auth`.

### Four facts that cost real time

These are recorded here because each one fails *silently* and you will not
diagnose it from the symptom.

**1. The callback URL cannot contain a port.** Todoist rejects it —
"must use HTTPS and cannot specify ports for security reasons". The App
Management form does not surface the error: it accepts the text, Activate
appears to do nothing, and the status stays "Not configured" forever. With
Tailscale this means Funnel on **443**, not Serve and not 8443. Serve is
tailnet-only and Todoist's servers are not in your tailnet.

**2. Testing from inside your own tailnet proves nothing.** MagicDNS resolves
the Funnel hostname to its tailnet address, so `curl` connects peer-to-peer and
returns a convincing 401 while the public path is entirely untested. Force the
public ingress with `curl --resolve` against an address from a public DNS
server.

**3. Creating the app does not switch on delivery to your own account.**
Webhooks are enabled per user by an OAuth round trip, and the console's
"Install for myself" button is not that flow. `aibroker todoist auth`. The
console's "Number of users" is not a reliable signal — it has read 0 for an
account that had genuinely authorised. Trust `aibroker todoist status`.

**4. A lapsed grant looks like a healthy channel.** Webhooks are verified with
the client *secret*, not the token, so **task delivery keeps working**. What
breaks is everything needing the API: comment routing (a comment payload has no
project or labels, so the parent must be fetched) and replying on a task. So the
signature is the asymmetry itself — **tasks arrive, comments do not.**

The response is `401` with `error_code 477` and a `retry_after` that climbs:
3, 7, 65, 129 seconds.

**That climb is not throttling, and this document said it was.** Todoist's
reference states that `retry_after` is backoff metadata not limited to 429s, and
that on a 477 you must *not* wait and retry the same token — an invalid token is
invalid, and waiting changes nothing. The escalating numbers look exactly like
rate limiting and are not. Corrected 2026-08-02, after the wrong explanation had
been repeated between two codebases and written down here as fact.

**Enable refresh tokens on the Todoist app.** Without them, Todoist issues
tokens with no `expires_in` and no refresh path: they die and can only be fixed
by re-authorising by hand, which is what produced two lapses in twenty hours.
With them, the token refreshes on demand and the daily re-auth disappears.

Fix for a grant that has already died: `aibroker todoist auth` and one click.

---

## Conventions

**Duplicate titles.** Two open tasks with the same title in one project is a
real hazard: a reply lands on the sibling you are not watching, and it is
indistinguishable from being ignored. On delivery the receiver counts open
tasks sharing a title and appends a note naming the count. Say which id you
answered on.

**Long content goes in a file, not in the task.** Todoist caps a task
description at 16,383 characters and enforces it by **truncation, not
rejection** — the request returns 200 and reports success. Measured 2026-08-02:
19,457 characters sent, 16,383 stored, 3,074 lost off the end. What went missing
was a runbook's close-out section, including the command that marks the task
done, so a session working from it would have done the job correctly and then
left the task showing a run in progress.

Since v0.18.4 `pai task add` compares what came back against what was sent and
warns on stderr with both counts. **That does not prevent the loss.** The tail is
still gone; the warning only makes a silent failure a loud one, and whether
anything happens next depends on someone reading stderr. Visible failure is not
absence of failure — put the runbook in a file and let the description point at
it.

The check compares lengths rather than testing against 16,383 on purpose. The
number is worth less than the shape: an API reporting success for an operation
that did not fully happen stays invisible until someone inspects the artifact
instead of the return value, and a hardcoded limit would be silently defeated by
a sink that changes its cap.

**Agent-authored content is marked** so a reply posted by a session does not
come back as a fresh instruction and loop.

**A dispatch that cannot land must be loud.** If the target session is gone and
no project mapping exists, the work cannot be delivered — that is recorded as
its own outcome and escalated, never dropped quietly. Deleting a project when
its session disappears is wrong: tasks filed against a dormant session queue
and dispatch when it next launches.
