# Task Bus — cross-session task routing via an external tracker

**Status:** design accepted 2026-07-31, not yet implemented
**Owner module:** PAI (new module `task-bus`), with AIBroker as an *optional* transport

---

## Problem

PAI sessions record work in per-project `Notes/TODO.md`. That works for work that
belongs to one session and stays there. It does not work for:

1. **Findings discovered sideways.** A session working on X notices Y. Y belongs to
   another project, or to no project. Today it gets mentioned in passing and lost.
2. **Cross-session pickup.** A morning routine should be able to read everything open
   across all projects and act on it — including work filed by a session that has since
   ended.
3. **Dispatch.** A task filed by session A, owned by project B, needs to reach a live
   B session — spawning one in the right directory if none is running.

The tracker is shared state that outlives any session. That is the point.

## Architecture — why PAI owns this and AIBroker does not

The deciding constraint is distribution. PAI ships to npm (`@tekmidian/pai`) with a tier
model and cross-platform users. AIBroker is macOS + iTerm2 personal infrastructure. If the
task domain lived in AIBroker, the feature could never ship to a PAI user who does not run
iTerm2.

| Concern | Owner | Rationale |
|---|---|---|
| Provider abstraction (Todoist, Things, Reminders, Linear) | **PAI** | Mirrors the existing notifications router, which already abstracts 4 providers |
| Ownership resolution (`pai:` label → project) | **PAI** | Needs the PAI project registry |
| Filing API + description convention + `hook://` links | **PAI** | Knowledge-layer concern; Hook MCP already integrated |
| Morning-routine skill | **PAI** | Skills are PAI's surface |
| Resolve name → live session, spawn if absent, deliver | **AIBroker** | Session lifecycle and messaging is only AIBroker's job |

**AIBroker is optional.** With it, PAI auto-dispatches and spawns sessions. Without it, PAI
reports `3 tasks belong to BirnPartners — run \`pai birnpartners\``. Same feature, graceful
degradation. Putting the task logic in AIBroker makes that degradation impossible.

The AIBroker primitives this relies on. This list said "the one new primitive:
`aibroker_dispatch`" for far longer than it was true — the surface grew and the
doc did not.

```
aibroker_dispatch(project, message)   resolve name/alias → live session? send : launch then send
aibroker_ask(...)                     liveness probe; fourth outcome "busy"
aibroker_sessions()                   live sessions with their PAI names
aibroker audit [--trace <id>]         append-only trail of cross-session action
aibroker todoist auth | status        OAuth grant for webhook delivery
todoist_reply(...)                    answer on the task a dispatch came from
```

**Setup for all of this is in `docs/task-bus.md`.** Webhook specifics are
maintained in AIBroker's own `docs/todoist.md` and deliberately not duplicated.

### Two delivery paths, not one

This document describes PAI polling Todoist on a launchd interval. That is no
longer the only path: AIBroker also runs a **webhook receiver**, and it is the
only path that carries `note:added` — comments.

That distinction is not cosmetic. A comment is how a correction reaches work
already dispatched. On the polling path alone, corrections are silently dropped:
nothing is subscribed to them, so the user appears to be talking to a system that
is listening and is not. Observed 2026-08-01 — two comments, no reaction, and
the cause was invisible from either side.

Likewise `reminder:fired`. **Due dates push nothing; only reminders do.** So the
webhook path also buys scheduling with no timer anywhere, which is why the
polling interval does not need to be short.

## Ownership resolution

Label is authoritative; the sub-project mirror is the fallback. Labels survive a task
being moved between projects, and work for tasks parked in `Findings 🔍` before triage.

```
resolve(task):
  1. label matching /^pai:(.+)$/        -> PAI project (authoritative)
  2. else sub-project name -> PAI alias -> PAI project (fallback, existing mirror)
  3. else                               -> UNROUTED, leave in Findings 🔍
```

UNROUTED is a normal state, not an error. `Findings 🔍` is an inbox; triage assigns owners.

## Verified constraints (measured 2026-07-31, not assumed)

These are the traps. Each was hit during design.

### Todoist REST v2 is dead — use unified API v1

`https://api.todoist.com/rest/v2/*` returns **410 Gone**. The live surface is
`https://api.todoist.com/api/v1/*`. Differences that matter:

- Every collection is wrapped and paginated: `{ results, next_cursor }`. Reading only the
  first page silently truncates.
- Tasks carry `checked` and `is_deleted` inline; both must be filtered or completed work
  gets dispatched again.
- Projects carry `is_archived` / `is_deleted`.
- There is no task `url` field — build the deep link from the ID.

Query tasks per bus project (`/tasks?project_id=…`) rather than draining `/tasks`: the
account may hold thousands, the bus holds a handful.

### Never resolve a tracker project by name-search

`mcp__todoist__find-projects search:"Claude"` returns **0 results** while the unfiltered
listing plainly contains `Claude 🤖`. A routine that resolves by search finds nothing and
reports "no tasks" — a silent failure, exactly the class `Routines 🔁` exists to catch.

**Rule:** resolve by stored ID, or list-all and filter client-side. Never by search.

### `pai project names --all` is not a drop-in for the shortlist

- The curated shortlist returns **10** projects with populated `names` aliases.
- `--all` returns **118** projects with `names: []` — no aliases, so nothing to resolve against.
- `--all` is genuinely ambiguous: three separate registry entries share `display_name: "Glidr"`
  (`glidr`, `glidr-1`, `glidr-2`) at different paths.
- **Two casings exist, and that is correct — do not "fix" it.** `pai project names --json`
  emits **snake_case** (`display_name`, `root_path`): the raw registry shape. AIBroker's
  `aibroker_pai_projects` emits **camelCase** because its `fetchFromCli()` normalises on
  ingest. Changing PAI's CLI to camelCase would break that mapping and yield `undefined`
  everywhere. A consumer picks one source and stays on it; there is nothing to reconcile.

**Rule:** bus participation requires an explicit curated alias via
`pai project name <identifier> <shortname>`. Do not widen the query to `--all`.

**Open bug:** normalize the two JSON shapes to one casing before any consumer depends on both.

### Launch coverage is the blocking gap

`aibroker_pai_launch` knows only the 10 curated aliases: `broker` `sl` `youdrill`
`jobs-matthias` `tekmidian` `mdf` `paicloud` `coogle` `jobs-grazyna` `pailot`.

The tracker sub-projects that exist today — `BirnPartners`, `Mail & Identity 📧`, `Whazaa` —
are **none of them**. 3 of 3 real cases cannot be spawned. Sessions like Home, Glidr, Devon,
Website, Solar, BOXit and World Monitor are live tabs with no registered project behind them.

**Fix:** curate an alias for every project that participates in the bus, before dispatch
can work at all.

## Provider interface

Modelled on `src/notifications/` (router + providers).

```ts
interface TaskProvider {
  name: string;                                    // "todoist"
  listOpen(opts): Promise<Task[]>;                 // due/overdue, by container
  add(task: NewTask): Promise<Task>;
  complete(id: string): Promise<void>;
  isConfigured(): boolean;                         // degrade if not
}
```

`Task` carries `{ id, title, body, owner, due, priority, labels, sourceUrl }`.
`owner` is the resolved PAI project or `null` (UNROUTED).

### Credentials — talk to the API, not the MCP

The Todoist MCP is a Claude-session-scoped stdio server; PAI's CLI and daemon cannot call
it. But its config carries a `TODOIST_API_KEY`, so the provider can use the Todoist REST API
directly. This is what makes `task-bus` real code rather than a skill-only workflow — the
daemon can run the bus without a Claude session attached.

**Do not scrape the key out of `~/.claude.json`.** A shipped feature must not read another
tool's config. Resolution order:

1. `tasks.providers.todoist.apiKey` in `~/.config/pai/config.json`
2. `TODOIST_API_KEY` environment variable
3. not configured → `isConfigured()` false → provider disabled, PAI degrades cleanly

## Hook integration

Task descriptions reference artifacts by `hook://` URL rather than filesystem path:
they survive renames and moves, and open in DEVONthink To Go on iOS. PAI generates the
link at filing time via `mcp__hook__hookmark_link`. Falls back to a plain path when
Hookmark is unavailable — Hook is optional, like AIBroker.

## Description convention

Task descriptions carry the **full procedure and the reasoning**, not just a title —
enough that the task is actionable months later, or by the user alone, without re-deriving
anything. This is inherited from the `Claude 🤖` conventions and is enforced by the filing
API rather than left to discipline.

## Known failure mode

Findings that are never triaged. If `Findings 🔍` stops being emptied, the bus is just
another place for items to rot. The weekly triage is load-bearing, not decorative —
if it lapses, the feature is not working regardless of what the code does.

## Tier placement

Free (`productivity` module). The bus is what makes multi-project PAI coherent; gating it
would undercut the free tier's core value. Provider plugins beyond the first may be a
reasonable Pro boundary later.

---

*Verified against: Todoist `Claude 🤖` (`6h9XrVWqgmrM5X79`), 8 live tasks across the parent
and 3 sub-projects; PAI registry 118 projects / 10 curated; AIBroker 23 sessions.*
