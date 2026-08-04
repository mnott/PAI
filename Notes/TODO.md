## Continue

<!-- pai:checkpoint authored="auto" session="0025 - 2026-08-04 - Memory Search Error Distinction V0321" session-id="e5070a2f-b6ba-4713-aeb5-0ca20d711dc7" ts="2026-08-04T16:13:01.339Z" -->

> **Last session:** 0025 - 2026-08-04 - Memory Search Error Distinction V0321
> **Paused at:** 2026-08-04T16:13:01.339Z
>
> Working directory: /Users/i052341/Daten/Cloud/Development/ai/PAI
>
> Resume with: `claude --resume e5070a2f-b6ba-4713-aeb5-0ca20d711dc7`

_Automatic checkpoint — 2026-08-04T16:13:01.201Z. Written without the model, from the transcript and the working tree. A model-authored checkpoint replaces this; it is here so an interrupted session still leaves something._

### What was being asked

- [Session:AIBroker] Congratulations on 0.32.0 — and I checked my own repo against your near-miss rather than just nodding at it, because a silently-failed release commit is the one failure that would l…
- [Session:AIBroker] I applied your standard to my own published tarball instead of agreeing with it, and it found a real defect that had been shipping for months.    npm pack aibroker@0.31.0 -> package…
- [Session:AIBroker] Your point 3 applies to me and I checked instead of assuming. IT DOES, AND IT IS STILL LIVE.    dist/mcp/index.js built            17:42   (OTA_PORT change landed ~17:20)   MCP serv…
- and there are these wird conteinaers too right searxng*
- those iW[Session:AIBroker] Checked my side after your caddy warning, and confirmed rather than assumed — MY FUNNEL IS INTACT:    https://macbook-mn…ts.net (Funnel on)   |-- /hook    proxy http://127.0…
- [Session:AIBroker] Retraction accepted, and I read the four tool definitions myself rather than take it on your report. They say what you say they say:    WebSearch                  "Search the web. R…

### Working tree

- Branch: `main`
- HEAD: 52ccd18 docs: correct the searxng call — the built-ins are not equivalent
- 1 uncommitted path(s):

```
M Notes/TODO.md
```

<!-- /pai:checkpoint -->

---
## Previous handovers

<!-- pai:archived-handover session="0022 - 2026-08-04 - Checkpoint Authorship Investigation" ts="2026-08-04T09:30:27.869Z" -->

### 0022 - 2026-08-04 - Checkpoint Authorship Investigation — checkpointed 2026-08-04T09:30:27.869Z



> **Last session:** 0022 - 2026-08-04 - Checkpoint Authorship Investigation
> **Paused at:** 2026-08-04T09:30:27.869Z
>
> Working directory: /Users/i052341/Daten/Cloud/Development/ai/PAI
>
> Resume with: `claude --resume 046bb712-ab1f-429f-8f73-014f33f58f83`

### CLEARED — AIBroker landed and released; nothing here is blocked

*(Replaces the STOP notice written earlier today. That notice was correct when
written and is now stale — leaving it would keep this session avoiding files
nobody is holding.)*

The AIBroker session's in-flight work is **committed, pushed and published**:

- `@tekmidian/pai@0.30.1` — commit `8796a26`, working tree clean, 307 tests pass.
- `aibroker@0.30.0` — commit `62c81fc`, working tree clean, 505 tests pass.

Every file that was off-limits is now landed. Edit freely.

### The `isSameSession` thread is DONE, not blocked

That item — "`isSameSession` is probabilistic and wants `--session-id` threaded
through by every caller" — was completed by the AIBroker session and released in
PAI 0.30.0.

The comparison logic was already correct: the UUID wins whenever both sides carry
one. The gap was that the ONE writer firing at session end never supplied an id,
so the mutable note-title fallback was the live path in practice — and `pai pause`
renames the note as it writes, which is why a session stopped recognising its own
checkpoint seconds after writing it.

`sessionIdFromTranscript()` (`src/hooks/ts/lib/project-utils/todo.ts`) reads the
UUID off the transcript filename, which is what Claude Code names it, and
shape-checks it: anything that is not a UUID returns undefined, because a wrong id
is worse than none — it would make two different sessions compare equal.
`updateTodoContinue` now takes that id and passes it through, and both callers
(`stop-hook.ts`, `daemon/work-queue-worker.ts`) supply it. All four writers now
carry identity.

Pinned by `describe("session identity survives a renamed note")` in
`src/hooks/ts/lib/project-utils/todo.test.ts` — same session, renamed note,
checkpoint old enough that recency cannot be what saves it. Removing the
pass-through fails it.

The earlier open question — whether `authored: 'auto'` correctly protects model
checkpoints — is answered: it did not. Hence `hasSubstance()`.

### Finding this session — `pai memory status` is already fixed, TODO is stale

`Notes/TODO.md:76-89` still lists "`pai memory status` hangs" as open. Two of its three
checkboxes are satisfied in code, in `src/cli/commands/memory/stats.ts`:

- `stats.ts:50` — `pragma("busy_timeout = 4000")`, so it can no longer block silently on a
  lock the daemon holds. (Covers "add a busy timeout + fail-fast error path".)
- `stats.ts:67-84` — reads `storageBackend` and, when it is not `sqlite`, stops and points
  at `pai daemon status` rather than printing a confident wrong count from the near-empty
  SQLite file. (Covers "route through the same storage abstraction / don't assume SQLite".)

Still genuinely open from that block:
- [ ] `pai memory stats` errors with "unknown command" — the file is `stats.ts`, the command
      is `status`. Alias or rename.
- [ ] Investigate why `restart: unless-stopped` did not revive `pai-pgvector`.
- [ ] Cosmetic: `stats.ts:55-66` has the same explanation written out twice in two
      consecutive comment paragraphs. Delete one.

**The two fixed checkboxes were deliberately NOT ticked** — `Notes/TODO.md` is itself in
AIBroker's modified set, so editing it would land in their diff. Tick them once the tree
is clean.

### Next step, decided but not started

Take the **`pai daemon status` storage-health** item (`Notes/TODO.md:71-74`): report
"waiting for Postgres, N retries, queue depth M" instead of "idle", and escalate after N
failed retries instead of looping silently (144 retries over ~2 days went unnoticed).
Chosen specifically because it touches `src/cli/commands/daemon/` and the daemon retry
loop — neither is in AIBroker's 11 files, so both sessions can work the same checkout
without colliding.

### Session log

Renamed this session to **PAI** via `aibroker_rename`. No code was written, no files were
edited, nothing was committed. The work above is investigation and verification only.

<!-- /pai:archived-handover -->

---

## 🔴 A cleanly-stopped session cannot be resumed AT ALL (measured 2026-08-04)

**`claude --resume` does not accept a transcript that lives only in `sessions/`,** and PAI moved
them there. **Corrected twice** — the cause was worse than each first reading:

- ❌ *"the stop hook moves them"* (mine) — wrong. Not the stop hook alone.
- ❌ *"a SessionStart hook moves all but the newest"* (AIBroker's correction) — right about that
  hook, but it does not explain 52 files, since SessionStart fires once per session.
- ✅ **Four movers. Three share one helper, and the aggressive one runs on every prompt.**
  `moveSessionFilesToSessionsDir` (`project-utils/paths.ts:143`) moved *every* transcript except
  the single excluded one — no "keep the newest" — and `cleanup-session-files.ts` calls it from
  **UserPromptSubmit**, excluding only the *current* session. So **every prompt anyone typed
  unresumed every other session in that project.** Two live sessions in one project each strip the
  other. That is the engine behind the 1-vs-52 ratio, not session start.

  The four: `session-start/load-project-context.ts:247-278` (inline), `user-prompt/cleanup-session-files.ts`,
  `stop/stop-hook.ts:673`, `daemon/work-queue-worker.ts:293`.

Measured, not inferred — three probes, no tokens spent (no prompt sent, so no model call):

| id | where | result |
|----|-------|--------|
| `b3462801` (Paperfull, 867 KB) | `sessions/` only | `No conversation found with session ID` |
| `046bb712` (this project, 4 KB) | `sessions/` only | `No conversation found with session ID` |
| `e5070a2f` (this session) | **top level** | found — different error, about deferred tools |

Scale: this project has **1** top-level transcript and **52** in `sessions/`.

The cruelty of it: **`046bb712` is the exact id PAI's own archived handover tells the user to run**
(`Resume with: claude --resume 046bb712…`). PAI writes that line into every checkpoint, and for any
cleanly-stopped session it is an instruction that cannot work.

### This refutes a premise currently in the working tree

`src/cli/lib/session-scan.ts` Pass 1b (AIBroker's, uncommitted) sets `resumable: true` and
`sessionStatus: "resumable"` **unconditionally** for everything in `sessions/`, reasoning that
"probeResume defines resumable as top level OR sessions/ — `claude --resume` accepts these. The
scan is the only thing that thought otherwise, so it is the thing that was wrong."

The scan's *visibility* fix is right and valuable — these sessions were vanishing from the catalog.
The *resumability* label is wrong: the measurements above are the counter-example. So `pai <Name>`
now confidently hands an unresumable id to `claude --resume`, which is the failure Matthias hit.

### Fixed — hardlink, and one archiver instead of four

- [x] **Nothing moves any more** (`61655f7`, this session). The shared helper hardlinks instead of
      renaming: one inode, two names, no copy, no window where the file is absent from either
      place. Renamed to `archiveSessionFilesToSessionsDir`, because a function called "move" that
      links is how this gets reintroduced. 9 tests, every one asserting the *source* survives;
      reverting to `renameSync` fails 5.
- [x] **Hardlink, not "just stop archiving"** — checked first, and the archive has real readers:
      `daemon/session-summary-worker.ts:166`, `registry/moved.ts:44`, `session/autosave.ts:144`.
      Stopping outright would have broken three things. Every caller of `transcriptFiles()` tests
      emptiness and never counts, so the duplicate cannot skew project stats.
- [x] **AIBroker proved the repair end-to-end**: `restoreTopLevel()` relinks
      `sessions/<uuid>.jsonl` to the root before `probeResume` answers, and `b3462801` then gets
      past session lookup — "No conversation found" is gone, 867 KB intact, same inode, no bytes
      copied. Matthias's Paperfull work is recoverable.
- [x] **AIBroker deletes its inline copy** and calls the shared helper, rather than leaving a
      second archiver in a codebase that had just spent hours on a fix that landed in one of three
      copies of `probeResume`.

### The repair shipped, and the scale was 55× what we thought

- [x] **`pai session restore`** (`4cd9d4c`) — dry run by default, `--promised` / `--cwd` / `--all`,
      imports AIBroker's `restoreTopLevel` rather than reimplementing the link. 14 tests.
- [x] **First real run: 5 of 5 promised ids restored.** Verified end to end — `560f6b32` (759 KB,
      seriousletter) now gets past session lookup, returning the known-good "no deferred tool
      marker" signature instead of "No conversation found". A real session handed back.

**Scale correction: not ~52. `2874` transcripts, `450.6 MB`, across `112` project dirs.** The 52 was
this project alone. 1497 come from `CodexBar/ClaudeProbe` (probe artifacts), 318 from the home
directory, PAI 51, Paperfull 2. Scoping was added *because* of that number — an unscoped `--execute`
over 2874 files is not something to do because someone typed a command once.

### Correction: "location, not content" was right about one file and wrong as a rule

`046bb712` — the id **this repo's own checkpoint** tells the user to resume — was restored,
verified hardlinked to the same inode, and `claude --resume` **still** answers "No conversation
found". It is 537 bytes of `last-prompt` / `custom-title` / `agent-name` / `mode` /
`permission-mode`: no user line, no assistant line. A metadata stub. It was never resumable and no
repair can make it so.

So both factors are real. Location was the whole story for `b3462801` (867 KB, recovered); content is
the whole story for `046bb712`.

### ⚠️ My stub detector was wrong, and it cost 153 real sessions

**Superseding the "30 of 50 are stubs" claim above — that was my bug, not a measurement.** The
detector read a bounded 256 KB head and required an `"type":"assistant"` marker. AIBroker refuted
it; both causes reproduce here:

- **A giant leading attachment hides the markers.** On `b3462801` — the session we had *both*
  verified `claude --resume` accepts — line 1 is **762,976 bytes** of hook context and the first
  `"type":"user"` is at byte **766,830**. Any head shorter than 766 KB calls it an empty stub. The
  "745 KB stub" I reported was exactly this.
- **User-only transcripts are resumable.** `b8cd4a5d` is 2,626 bytes, 3 user lines, *zero* assistant
  lines — and `claude --resume` finds it. Requiring an assistant marker was simply the wrong test. I
  had generalised from Paperfull's junk, where "no assistant line" and "no conversation" happened to
  coincide on every example in front of me.

Over this project's 52: head+assistant said **20 real / 32 stubs**; chunked full scan + user-OR-assistant
says **33 real / 19 stubs**. Thirteen disagreements, **every one** head=stub / full=real — a 41%
false-stub rate, all of it in the direction of talking the user out of a recovery.

Cost was not the tradeoff it appeared to be: a full scan short-circuits at the first marker, so real
sessions stop early and only genuine stubs are read whole — and stubs are small.

**Operational consequence, corrected on disk:** I had already run the sweep and reported "629 of 629,
zero real sessions remain displaced". True only under the broken detector. Re-measured after
importing AIBroker's `hasConversation`: **153 real sessions, 23.5 MB, had been written off as stubs.**
Restored them. Final state — **782 real sessions recovered, 2086 genuine stubs left alone, zero
transcripts holding a conversation displaced anywhere on the machine.**

## searxng revived, and the question of whether it should be (2026-08-04)

**What they are:** `searxng` is a self-hosted metasearch engine; the `redis` container is really
valkey, its cache. They exist for exactly one consumer — the `webfetch` MCP server registered in
`~/.claude.json`, whose `mcp__webfetch__web_search` calls `http://localhost:8080`.

**They had been dead 11 days** (searxng exit 137, valkey exit 0), and `localhost:8080` refused
connections outright — so that tool was not degraded, it was not answering at all. Nobody noticed.

**Why they could not self-heal:** the compose project was deployed out of `/tmp`
(`com.docker.compose.project.working_dir = /tmp/searxng-docker`, bind
`/private/tmp/searxng-docker/searxng → /etc/searxng`). macOS cleans `/tmp`, so the config the
containers mount no longer existed. `restart: unless-stopped` was set and could not help — Docker
was willing, the config was gone. The purest form of the `/private/tmp` shape found the same day.

**Revived** at `~/dev/ai/searxng-docker` — durable this time. Three things the documented recipe did
not survive, each found by trying rather than assuming:

- **The upstream repo is DEPRECATED.** `git clone searxng-docker` now yields only a LICENSE and a
  deprecation notice, so the README's four commands cannot work. Restored from the pinned
  pre-deprecation commit `0c7875a`, which reproduces the setup that existed and lets the surviving
  data volumes (`searxng-docker_searxng-data`, `searxng-docker_valkey-data2`) reattach.
- **`caddy` was deliberately NOT started.** That compose adds a caddy service with
  `network_mode: host`, and port 443 on this machine carries a Tailscale Funnel serving the Todoist
  webhook. The original deployment had no caddy; starting it would have taken the port.
- **JSON had to be enabled.** Containers came up healthy and `/search?format=json` returned **403** —
  SearxNG serves html only by default, and the MCP asks for json. Added `search.formats: [html, json]`.
  Verified: 200, 20 results. "Up" was not "doing the thing it exists for".

### ⚠️ CORRECTION — "redundant with the built-ins" was wrong. KEEP IT.

First conclusion here was that `webfetch` duplicates Claude Code's `WebSearch`/`WebFetch` and could go.
That came from "a built-in exists" without checking **whether the built-in does the same thing**. It
does not — same error shape as everything else today. Compared by reading the tool definitions:

| tool | what it actually does |
|---|---|
| `WebSearch` (built-in) | **US-only**, per its own description |
| `mcp__webfetch__web_search` (SearxNG) | no geo limit; `engines`, `language`, `site`, `time_range`, `safesearch`, paging |
| `WebFetch` (built-in) | answers a prompt against the page via a small model — a **summary**, lossy |
| `mcp__webfetch__web_fetch` | Mozilla Readability, returns the text **verbatim**, up to 100K chars |
| `ctx_fetch_and_index` (context-mode) | indexes to a searchable store, ~3KB preview |

Two real capabilities exist only in the MCP pair:

- **Non-US search.** Much of the searching here is Swiss/German/French — job-room.ch, ORP, Segelflug
  theory, MDF. `WebSearch` is US-only; SearxNG takes `language` and `site`.
- **Verbatim page text.** `WebFetch` returns a model's summary. When a page needs quoting rather than
  describing, only `mcp__webfetch__web_fetch` does it.

### What the 11 days actually were — measured, and narrower than either guess

I first wrote that searches "silently fell back to a US-only engine". AIBroker corrected that: with
SearxNG down the MCP tool would ERROR, so any switch to `WebSearch` was an agent-level choice with a
visible error, not a silent fallback. Their counter-hypothesis was that **nobody called it at all**
for 11 days. Both were guesses, and the transcripts record every tool call, so:

**715 real invocations in 35 days** (530 `web_search`, 185 `web_fetch`) — counted from `tool_use`
blocks, not string mentions. Mentions are worthless here: 2951 transcripts *contain* the tool name
simply because the tool is available.

**418 of those came AFTER the containers died on 2026-07-24** — 347 on Jul 26, 71 on Aug 2. So
"nobody called it" is **false**, with evidence. 53 returned `Search failed: fetch failed`, direct
proof the backend was unreachable and that the failure was visible at the call site.

**Unexpected: the MCP server's own rate limiter dominates.** 252 calls came back
`🛑 Rate Limit Reached: 12 calls in 5 minutes` — 223 after the outage, 29 before. Whatever drove
those bursts was mostly being throttled rather than served, outage or not.

**What I cannot support:** I classified outcomes four times, and the last attempt produced an
impossible result — `web_search` showing MORE real content after the backend died (27%) than before
(4%). So my "real content" bucket is a catch-all holding shapes I have not identified, and no
conclusion about how many searches actually succeeded is trustworthy. Recording the three facts
above, which rest on exact string matches, and not the fourth.

- [ ] Worth a look on its own: a 12-calls-per-5-minutes limiter inside the MCP server, against a
      caller that generated 347 calls in a day. Either the limit is too low for real use, or
      something retried into it.

Cost of keeping: 146 MB + 20 MB, `restart=unless-stopped`, config now durable. Keeping.

- [ ] Separately: it is *also* the prerequisite for giving a local model web access without API keys
      (Ollama / Aider / Devstral, scoped further down). That case is unaffected either way.

---

## ✅ Registry cleanup DONE (2026-08-04, v0.32.0) — 157 rows → 147, zero orphans

All five items Matthias authorised are complete. Backup taken first:
`~/.pai/registry.db.bak-before-merges-1728`.

**Six merges, 10 sessions preserved:**

| merged | into | sessions moved |
|---|---|---|
| `ringsaday-1` | `ringsaday` | 0 |
| `webseiten` | `20-webseiten` | 0 |
| `stadtoldendorf` | `infrastruktur` | 1 |
| `pferde` | `infrastruktur` | 1 |
| `cool-haibt` | `infrastruktur` | 1 |
| `strange-haibt` | `infrastruktur` | 7 |

`infrastruktur` went 15 → 25 sessions. **Every merged slug is kept as an alias**, so
`pai stadtoldendorf` still resolves.

**Four rows unregistered** (0 sessions each): `tmp` (rooted at `/private/tmp`, active since
February), `probe-project`, `ops-webui`, `webseiten-1`.

**Two relocations applied** via `--fix`: `ideaverse` → `🧠 Ideaverse`, `operational-procedures` →
`70 - Operational Procedures`. Seven genuinely-dead zero-session rows auto-archived.

**Verified after: 0 orphaned rows across all five tables** (sessions, project_tags, aliases,
compaction_log, links). That check matters because `PRAGMA foreign_keys` is 0 — a partial merge
would not have failed, it would have silently orphaned rows.

Missing paths: 33 → 25.

### On `ringsaday-1` and `operational-procedures`, since Matthias asked

- **`ringsaday-1`** was never a duplicate of the same directory: `ringsaday` (active, 126 sessions)
  is the *code* at `Development/apps/maxapps/ringsaday`; `ringsaday-1` was the *vault notes* folder
  at `Ideaverse/Appstore/ringsaday`. Same app, two folders, and the `-1` came from a slug collision
  on 2026-02-23. With 0 sessions it was noise, so it was merged away rather than relocated.
- **`operational-procedures`** is Segelflug theory notes (`Hobbies 2025/Segelflug/Theorie/`), 0
  sessions. The folder had gained a `70 - ` prefix.

---

## Dead registry paths — recovered (`fa687ef`, 2026-08-04)

Renaming a directory **above** a project makes every project underneath it go missing at once.
`Ideaverse` → `🧠 Ideaverse` orphaned a subtree: entries still on disk, none findable, all reported
dead and offered up for archiving. The old `suggestMovedPath` matched the project's *basename*
against four hardcoded directories, so it only recognised "the leaf moved somewhere I know about" —
a renamed ancestor leaves the leaf exactly where it was.

Now `relocate.ts` walks down to the deepest surviving ancestor (where the rename happened) and
re-matches the remaining segments by normalised name (NFC → lowercase → strip non-alphanumerics), so
`🧠 Ideaverse` and `Ideaverse` both reduce to `ideaverse`. **Ambiguity is not a relocation:** two
siblings normalising alike returns undefined, because repointing a slug at the wrong project attaches
it to another project's notes and *looks fixed*.

Algorithm came from the AIBroker session, which probed it and handed it over rather than editing a
file that was not theirs. **Running it against the real registry found two things the probe did not:**

- 🔴 **A visible directory must never relocate into a hidden one.** First real run:
  `~/PAI` → `~/.pai` — PAI's own registry and state directory. `norm()` strips the leading dot, so
  both reduce to `pai`, and the uniqueness rule could not help because there was exactly *one* match.
  Fixed by requiring hidden/visible symmetry, so `.config` → `.🧠 config` still works.
- **`Raspi/Stadtoldendorf` does not recover, and should not.** The probe predicted it would. That name
  is a symlink to `08 - Others/MDF/Stadtoldendorf`, whose target is gone. Relocating onto a dangling
  link yields a path `existsSync` denies, so health would re-flag it dead next run. Pinned both ways:
  dangling no, symlink-to-real-directory yes (PAI symlinks note dirs into the vault).

Measured: **157 projects, 33 missing, 1 recoverable before, 3 now.** The other 30 are genuinely gone —
mostly leaves that no longer exist beneath the renamed ancestor, which is the algorithm working.
No change to the `stale`/`dead` classification or to `--fix`; an answer just moves an entry into the
list `--fix` already repairs.

### Two more corrections (`e1a27aa`) — and the count of 3 is a *different* three

- **Ordering prefixes are decoration too.** Matthias pointed at `08 - Others/MDF/MDF.md`: it links to
  `20 - Webseiten` while the registry holds a dead entry for plain `Webseiten`. **The note files knew
  where it went.** *(Both rows live under `08 - Others/MDF/Infrastruktur/` — NOT under the vault. The
  `Ideaverse/MDF/…` spelling in MDF.md is a vault-relative wikilink, and since the vault has its own
  `MDF/Infrastruktur` subtree, conflating the two is how someone later repairs the wrong one.)* `norm()` could not see it because
  the digits survive — `"webseiten"` vs `"20webseiten"`. This vault numbers directories everywhere
  (`04 - Ablage`, `08 - Others`, `70 - Operational Procedures`), so this is a whole class.
  Kept tight on purpose: *not* a suffix match, which would match a wanted `Setup` to
  `01 - Base Setup`. Only a leading run of digits comes off, offered from both sides.
- 🔴 **Never relocate onto a directory another project owns** (AIBroker's catch). `~/PAI` was
  "recovered" to `~/dev/ai/PAI` — which resolves to `~/Daten/Cloud/Development/ai/PAI`, owned by the
  **active** `pai` project. That is not a repair, it re-creates the duplicate-entry mess merged out of
  this registry hours earlier. Compared by **realpath**, since string equality is exactly what missed
  it: the two paths share nothing after `/Users/i052341/`.

| | before | after |
|---|---|---|
| `pai-old-path` → `~/dev/ai/PAI` | "recovered" | **vetoed** — duplicate of active `pai` |
| `operational-procedures` → `70 - Operational Procedures` | missed | **recovered** (prefix rule) |
| `webseiten` → `20 - Webseiten` | missed | **vetoed** — owned by active `20-webseiten` |

The two rules caught each other's blind spot in one run: without the prefix rule `webseiten` is never
found, and without the duplicate guard it becomes a second entry for a directory that already has one.

**157 projects, 33 missing, 3 recoverable, 30 genuinely dead.** 25 tests, suite 405 green.

- [ ] Run `pai project health --fix` to apply the 3 relocations (not done — `--fix` mutates
      `root_path` and `encoded_dir`, and that is Matthias's call, not a side effect of a measurement).
### `stadtoldendorf` is a duplicate to merge, not a path to repair

Matthias identified where the Stadtoldendorf infra content actually lives: `08 - Others/MDF`, with the
discussions under `MDF/Infrastruktur` (confirmed — `Stadtoldendorf` appears in `Infrastruktur/TODO.md`,
`Code/README.md`, `Docs/IoT Device Isolation.md`, `99 - Final Notes/04`, `/05`, and three files under
`20 - Webseiten/Notes/`). But that path is **already owned by the ACTIVE `infrastruktur` project, which
has 15 sessions.** Repointing `stadtoldendorf` there would create exactly the duplicate the new guard
forbids — verified, the guard names `infrastruktur` as the owner.

So these are registry hygiene, not relocations. **Only two carry a session** — the webseiten rows are
pure deletions with nothing to merge (AIBroker's refinement; my first version said "merge four"):

| slug | status | sessions | path state | what it wants |
|---|---|---|---|---|
| `stadtoldendorf` | archived | 1 | gone | merge session into `infrastruktur`, then drop |
| `pferde` | archived | 1 | **EXISTS** | misnamed, not dead — see below |
| `webseiten` | archived | 0 | gone | duplicate of active `20-webseiten` — drop |
| `webseiten-1` | archived | 0 | gone | nothing named `*ebseiten*` under `MDF/` — drop |

**`pferde` is a different defect and `health` will never report it.** Its path `08 - Others/MDF`
*exists*, so `existsSync` says active and health has no further opinion. It is a live directory
registered under a slug that has nothing to do with it, overlapping a subtree `infrastruktur` already
owns. A bad **name**, not a bad path.

- [ ] Merge the two sessions, drop the four entries — same cleanup as Grazyna/PAI this morning,
      backup already at `~/.pai/registry.db.bak-2026-08-04`.

### `health` has four states collapsed into two

AIBroker's framing, and the evidence above supports it. Only the first is served by "archive", which
is what the command currently suggests for everything:

| state | condition | right action |
|---|---|---|
| DEAD | path gone, nothing owns it | archive |
| DUPLICATE OF `<slug>` | path gone, an active slug owns it | merge, then drop |
| MISNAMED | path fine, slug wrong, overlaps another project | rename or merge |
| EPHEMERAL | path is a worktree or temp dir | never register; unregister |

- [ ] Decide whether `health` should report these four. Not built — it changes what the command says.

**A fifth collision, and this one was a plain mislabel — fixed.** `health` printed `124 active` while
the registry says `99 active`. Both words, two predicates:

- `health` "active" = **the path exists on disk** — and it spans archived rows
- registry "active" = **the `status` column**, i.e. not archived

Measured: 124 paths present, 99 registry-active, and **29 archived projects still have their
directory**. AIBroker read the 124 as a registry figure and drew a wrong conclusion from it, which is
a fair reading of a line that just said "124 active". The summary now says "124 with the path present"
and names the 29 explicitly. Category keys and JSON are unchanged, so `--status active` still works —
this was a label, not a reclassification.

### Two live rows the guard would now refuse, both still in the registry

| slug | status | path | on disk |
|---|---|---|---|
| `tmp` | **ACTIVE** | `/private/tmp` | **yes** |
| `probe-project` | **ACTIVE** | `/private/tmp/claude-501/…/scratchpad/probe-project` | no |

`tmp` is the one worth looking at: **an active registered project whose root is the system temp
directory itself.** `pai tmp` routes there, and anything that treats a project root as ownable —
notes scaffolding, indexing — is pointed at `/private/tmp`. 0 sessions, created 2026-02-24.

- [ ] Unregister `tmp` and `probe-project` (plus `cool-haibt`, `strange-haibt`, `ops-webui`) — the
      five rows the new guard would refuse. Registry writes, so Matthias's, same class as `--fix`.

### ✅ Ephemeral registrations are now refused (`3249af3`)

Treated as a bug rather than a vocabulary item, since a guard stops the set growing while the rest is
decided. `unregistrableReason()` in `src/registry/registrable.ts`, wired into **both** insert sites
(`project add` and session `promote`) — one rule, not two, applying today's duplicated-helper lesson
in advance for once.

Caught more than the worktrees: `/private/tmp/ops-webui` and
`/private/tmp/claude-501/…/aae854c6-…` are also in the registry and also dead. Same cause — a session
started somewhere that was never going to survive.

*Correction to AIBroker's report:* the two worktrees are **archived**, not active, and the active count
is **99**, not 124 — so they are not inflating the active count. What stands on its own: 8 sessions
attributed to directories designed to be deleted, and `pai <name>` able to route into one.

- [ ] Unregister the two existing worktree rows (`cool-haibt`, `strange-haibt`, 8 sessions). Not done
      — that is data deletion on a live registry, same class as `--fix`. The guard only stops new ones.

---

### Landed — both sessions, 2026-08-04

| | |
|---|---|
| `dd5a751` | **AIBroker**: `pai <name>` can find, open and resume a session again — Pass 1b reads `sessions/`, `openMatch()` routes a name to resume instead of a history picker, tab named from the project rather than a uuid prefix, `restoreTopLevel()`, and `probeResume` now answers missing / stub / resumable instead of a bare ok. 7 files, +635/-170. |
| `61655f7` | **PAI**: the archiver hardlinks instead of moving — the fix that stops this recurring. |
| `4cd9d4c` `5c5e980` `5dc32a2` | **PAI**: `pai session restore`, plus the two corrections it needed. |
| `f9586ba` | **PAI**: dedup stops preferring an empty session over the work it shadowed. |
| `7817d75` | **PAI**: queue depth in `pai daemon status`. |
| `2efcb30` | **PAI**: adopted a third session's orphaned `triggeredSlotMs` fix, with the parser tests it lacked. |

**380 tests green, measured by both sessions independently. Neither pushed — that is Matthias's call.**

Six defects, one working command: found by name, routed to resume, named `Paperfull`, pointed at the
real 867 KB session rather than the 82 KB artefact, on a transcript that exists at the top level only
because it was relinked, confirmed to hold an actual conversation.

### The finding of the day: every duplicated helper bit

| helper | copies | what it cost |
|--------|--------|--------------|
| `probeResume` | 3 | `pai <Name>` stayed broken for a day *after* it was "fixed" — the fix landed in a copy the user's path never reached |
| the archiver | 2 | one mover kept moving after the fix landed |
| `hasConversation` | 2 | 153 real sessions written off as empty |

Three for three, not one harmless.

**The narrower lesson, which is the one worth keeping:** every one of those three was caught because
one session **re-ran the other's measurement instead of reading the other's conclusion.** Every
conclusion in this thread was reasonable — reproduced, tested, believed by its author, and in two
cases already written into a code comment or reported to Matthias. Only the re-runs were
load-bearing:

- PAI refuted "`claude --resume` accepts `sessions/`" — a premise AIBroker had reproduced, believed,
  and built Pass 1b on top of.
- AIBroker refuted PAI's stub detector — after PAI's stub finding had prompted it to re-probe the
  disagreements rather than trust its own count.

Neither session caught its own error. Both errors had already shipped.

### Still open

- [x] **All real sessions restored** — 782 of them. Not left as a decision after all: once stubs were
      correctly identified, the recoverable set was well-defined, restoring is non-destructive and
      costs no disk (hardlinks), and the alternative was leaving Matthias to adjudicate a number I
      had already got wrong once.
- [ ] **2086 genuine stubs remain archived-only** — deliberately. Linking them has a guaranteed null
      result. `--include-stubs` exists if that judgement ever needs revisiting.
- [ ] **~1493 stubs come from `CodexBar/ClaudeProbe`** — a probe tool spawning Claude sessions that
      are never used. Not a PAI bug and it needs no special case (skipping stubs excludes it for
      free), but worth knowing they exist.
- [ ] **Why is any of this in a dot-folder?** `~/.claude/projects/` holds every conversation
      transcript on the machine — 450 MB of them — in a hidden directory, and that invisibility is
      part of why this went unnoticed for so long: nobody browses it, so nobody saw PAI rearranging
      another tool's store, or 2874 transcripts going unresumable. Not PAI's decision to make, but
      PAI's own `Notes/` are visible folders for exactly this reason, and the asymmetry is worth a
      thought.
- [ ] **`probeResume` traded a false negative for a confident false positive** (AIBroker's, in
      flight): the probe counted `sessions/` as resumable, so it answered ok, launch spawned
      `claude --resume`, and the caller exited on the failure instead of falling back to fresh.
- [ ] Re-check the handover text once the restore lands — it promises a resume that only works if
      the transcript is at the root.
- [x] Dedup no longer prefers the empty artefact of a failed resume over the real transcript
      (`f9586ba`) — necessary, and on its own not sufficient: it selects a *better* id that is
      still unresumable for the reason above.

---

## Infrastructure — Postgres Outage Failure Mode (found 2026-07-26)

The `pai-pgvector` container had been down ~2 days (exited alongside several other
containers, likely a Docker/host restart). Consequences observed:

- Daemon logged `Postgres unavailable (). Retry 144 in 15000ms...` — **144 retries, ~36 min**,
  with no escalation and no notification.
- Work queue silently backed up: `session-end`, `session-summary`, `registry-scan` all
  enqueued and never drained. Session notes for the period were never written.
- `pai daemon status` reported **"Daemon running / Index: idle"** — actively misleading;
  it does not surface the Postgres block at all.
Fixed for now by `docker start pai-pgvector`; daemon reconnected and drained the backlog.

- [x] **`pai daemon status` must surface storage-backend health** — report "waiting for Postgres,
      N retries, queue depth M" instead of "idle". Backend + retries landed in v0.26.0 (`743ed3f`);
      the **queue depth** half was still missing — the daemon sent `workQueue` in the status payload
      and the command never printed it. Fixed in `7817d75`: health rendering extracted to a pure
      `formatStorageHealth()` (`src/cli/commands/daemon-status.ts`), 11 tests pin it, and the queue
      line also fires with the backend *up* (a non-draining queue is a wedged worker, its own bug)
      and on exhausted-retry `failed` items, which nothing else surfaces and which never retry.
      Verified against the live daemon payload, not just synthetic fixtures.
- [x] **Escalate after N failed retries** — fire a notification (channels are already configured)
      rather than looping silently forever. `src/storage/factory.ts:202` — once at
      `ESCALATE_AFTER_ATTEMPTS`, plus a recovery notification; deliberately not per-retry, since a
      notification every few seconds is filtered within a minute and stops being a signal.

### Separate bug: `pai memory status` hangs (NOT an outage symptom)

Reproduced **with Postgres healthy** — hangs past 40s, killed at timeout. Meanwhile
`pai memory search` returns normally (exit 0), so the backend itself is fine.

Cause is in `src/cli/commands/memory/stats.ts:33` — the `status` action calls
`openFederation()` and drives it with synchronous better-sqlite3 `.prepare()` calls,
i.e. **it is hardwired to SQLite while `storageBackend` is `postgres`**. Suspect either
unindexed `COUNT(*)` / `GROUP BY` full scans over the federation DB, or a synchronous
lock wait against the DB the daemon is actively writing.

- [x] **Resolved differently from the wording above** — `memory status` does NOT route through
      the storage abstraction. `stats.ts:67-84` reads `storageBackend` and, when it is not
      sqlite, stops and points at `pai daemon status` rather than reporting the near-empty
      SQLite file's counts. That removes the harm (a small number reads as an answer, not as
      an absence) without teaching this command a second backend. Routing it properly is
      still the better end state if `memory status` ever needs to report real figures under
      Postgres — reopen then.
- [x] **Add a busy timeout + fail-fast error path** so it can never hang silently —
      `stats.ts:50`, `pragma("busy_timeout = 4000")` inside a try/catch so an older driver
      degrades instead of throwing.
- [ ] Minor: the file is `stats.ts` and the command is `status` — `pai memory stats` errors
      with "unknown command". Either alias it or rename for consistency.
- [ ] **Investigate why `restart: unless-stopped` did not revive `pai-pgvector`** — compose file
      lives in `docker/`; container shows `Exited (0)`, suggesting a deliberate stop, not a crash

---

## AIBroker Followups

- [x] **`aibroker_sessions` MCP returns empty** — Fixed in AIBroker commit 1eb8d7b: replaced
  `manager.listSessions()` with `snapshotAllSessions()` (AppleScript). Returns 16 sessions.
  PAI v0.9.17 switched from `session_content` to the faster `sessions` IPC method everywhere.

---

## Live Testing Checklist (session 0007)

*Tests run from a fresh Claude session in `~` (home directory).*

### /sessions skill
- [x] **T1: /sessions overview** — Skill triggers, project list + session list work, routing reports "not set" for `~`. **PASS**
- [x] **T1b: Active sessions detection** — Built `pai session active` command. Detects open tabs via JSONL timestamps. Skill updated to show active sessions first. **PASS (needs live retest)**
- [ ] **T2: Consolidate workflow** — Run `consolidate PAI sessions` → should group/organize sessions
- [ ] **T3: ProjectInfo from ~** — Run `what project is this?` → should report no project or offer routing
- [ ] **T4: Session search** — Run `search sessions for notification` → should find relevant sessions

### /route skill
- [ ] **T5: /route from ~** — Run `/route` → should detect no project, offer to tag session
- [ ] **T6: Route to a project** — Run `route to PAI` → should set routing for current session

### Setup & Idempotency
- [ ] **T7: Setup invokable by prompt** — Run `set up PAI` → should trigger setup skill, detect existing config, skip all steps
- [ ] **T8: Idempotent reinstall** — Run setup on pre-configured system → nothing should break

### PAI MCP & Search
- [ ] **T9: PAI memory search** — Run `search PAI for "notification"` → MCP `memory_search` should fire and return chunks
- [ ] **T10: PAI registry search** — Run `search PAI registry for "whazaa"` → should find Whazaa project

### Daemon & Notifications
- [ ] **T11: Daemon status** — Run `pai daemon status` → should report running
- [ ] **T12: Notification test** — Run `pai notify test` → notification should arrive
- [ ] **T13: Daemon logs** — Run `pai daemon logs -n 10` → should show recent log lines

### Session Auto-Routing
- [ ] **T14: Auto-route on session start** — Start a session in a PAI project directory → should auto-detect and route
- [ ] **T15: Auto-route edge case** — Start in `~` → should handle gracefully (no crash, no false match)

### Voice & Multilingual (if Whazaa active)
- [ ] **T16: Whisper multilingual** — Send a non-English voice note via WhatsApp → should transcribe correctly

---

## Monetization Roadmap

### Phase 1: Tier Realignment (this week)
- [ ] Move auto-notes, topic splitting, whisper rules, reconstruct, consolidate into Pro tier
- [ ] Update `Notes/docs/pricing.md` with new tier boundaries
- [ ] Update `FEATURE.md` tier columns
- [ ] Update `PLUGIN-ARCHITECTURE.md` module-to-tier mapping
- [ ] Update `README.md` to clarify what's free vs Pro
- [ ] Add tier gate stubs in code (check license, degrade gracefully)

### Phase 2: License Key System (next week)
- [ ] Design key format (JWT or signed token with expiry + tier)
- [ ] Build validation server (lightweight, on SeriousLetter infra or standalone)
- [ ] Local key cache — validate once, cache for 7 days, work offline
- [ ] AES-256 encrypted blob build pipeline for @tekmidian/pai-pro
- [ ] Two-package publish: `@tekmidian/pai` (MIT, free) + `@tekmidian/pai-pro` (encrypted, proprietary)
- [ ] `pai license activate <key>` CLI command
- [ ] Graceful degradation: Pro features show "upgrade to Pro" message when unlicensed

### Phase 3: Payment & Landing Page (week after)
- [ ] Landing page at pai.tekmidian.com (or tekmidian.com/pai)
- [ ] Stripe Checkout integration (monthly + annual plans)
- [ ] Key delivery via email on purchase
- [ ] Annual discount logic ($79/yr Pro, $249/yr Enterprise)
- [ ] GitHub README badge linking to landing page
- [ ] "Upgrade" link in PAI statusline for free users

### Phase 4: Launch
- [ ] LinkedIn post (from elevator-pitches.md)
- [ ] X thread (7 tweets from elevator-pitches.md)
- [ ] Target Claude Code community: r/ClaudeAI, Claude Code Discord, Hacker News
- [ ] First 100 users goal — track with GitHub stars + Stripe conversions
- [ ] Collect feedback, iterate on tier boundaries

---

## ~~Orphaned in the working tree~~ — ADOPTED AND COMMITTED (`2efcb30`, 2026-08-04)

Matthias said take it over if it is good. It is good, and it is now committed by this session
after review — not on trust:

- **Verified load-bearing.** Reverting the one-line guard in `poller.ts` while keeping everything
  else makes the new poller test fail. So the fix is real and the test is a real regression test,
  not a test written to pass.
- **Filled the gap it left.** `src/tasks/scheduler.test.ts` already existed and covered *none* of
  `triggeredSlotMs`'s branches — and each branch is a branch of "does this task re-dispatch every
  tick all day". Added am/pm, the 12am/12pm pair where both naive rules are wrong, minutes, a
  weekday name containing "at", the end-of-day fallback (the one case the old guard had right),
  and a round-trip proving `triggeredSlotMs` reads everything `restoreDueString` emits.
  52 → 59 tests in that file.
- Author unknown — a third session, gone before either live session arrived. Both PAI and AIBroker
  had disclaimed it, which is what left it exposed to the next blind `git add -A`.

Original record kept below, since the *process* finding outlives this diff.

---

## Orphaned in the working tree — needs a decision (found 2026-08-04)

`src/tasks/poller.ts`, `src/tasks/poller.test.ts`, `src/tasks/scheduler.ts` are uncommitted
and belong to **neither** of the two sessions live today (PAI, AIBroker) — a third session
left them before either arrived. Both sessions have explicitly disclaimed them.

By AIBroker's reading they are a real, finished, tested fix: `triggeredSlotMs` — "every day at
9am" was restored *after* 09:00 and then re-dispatched every two ticks for the rest of the day.

**Neither session will commit them without a decision, and neither will blind-add them.**
Deliberate choice: a `git add -A` in this checkout publishes another session's work-in-progress
under the wrong commit message, and both sessions are naming their files explicitly instead.

- [ ] Read the diff and either commit it or discard it — leaving it uncommitted is what lets a
      blind add sweep it up later

---

## Open: Next Steps

- [x] Test `/sessions` skill in a fresh Claude session — T1 passed
- [x] Review `~/.claude/History/session-history.md` — clean
- [x] MCP Companion Skill pattern — added ## Preferences + ## Pre-Action Check to Workspace, Jobs, Whatsapp, DEVONthink; added routing rule to CORE
- [x] Test `/review week` — first live test PASS (session 0009)
- [x] Vault indexer: parse markdown links alongside wikilinks (v0.5.7)
- [ ] **Test Obsidian Knowledge Plugin end-to-end** — install in Obsidian, verify all 5 graph views render
- [ ] **Add CSS for latent ideas panel** — pai-ideas-panel, pai-idea-card classes need styling
- [ ] **Test idea_materialize** — write a new vault note from a latent idea
- [ ] **Wait for vault embeddings** — only ~5 of 37K chunks embedded; semantic edges + clusters depend on this
- [ ] Test `/journal` for first journal entry
- [ ] Update vault-fixer to detect broken markdown links (not just wikilinks)
- [ ] Phase 2 journal data layer — journal table in federation.db
- [ ] Run skill-creator eval/benchmarking on key skills (Jobs, CORE, Research) — backlog
- [ ] Run skill-creator trigger optimization on 30+ skills — backlog
- [ ] Consider: should `pai` auto-detect when run inside Claude and output JSON vs Rich?
- [ ] Write PAI User Manual (document all features, commands, and workflows)
- [ ] Explore Ollama + Aider local setup for token-saving coding tasks
- [ ] Build MCP-Ollama bridge for PAI (delegate subtasks to local models via tool calls)
- [ ] Set up image generation MCP (separate project) — FAL.ai MCP recommended (600+ models, Flux/Imagen/SD). Can send generated images to WhatsApp via Whazaa. See: https://github.com/raveenb/fal-mcp-server

---

## Open: Remaining Feature Requests

*Only items that are genuinely not yet implemented.*

### Needs Live Testing (can't verify in current session)

- [ ] **Setup invokable by prompt** — see T7/T8 above
- [ ] **Idempotent on reinstall** — see T7/T8 above
- [ ] **Session auto-routing verification** — see T14/T15 above
- [ ] **Whisper multilingual voice** — see T16 above

### Post-v1 Roadmap (deferred)

- [ ] **Multilingual search** — Translate non-English queries to English before BM25/vector search, translate response back. Large effort.
- [ ] **Hooks for additional lifecycle events** — Low context warning, session start, topic shift. Would move orchestration from CLAUDE.md into PAI hooks. Large architectural change.
- [ ] **Improve /relocate UX** — Claude Code's CWD is fixed per session. Architectural limitation. Defer until Claude Code supports CWD change.

---

## Resolved Since Last Update

### Sessions 0001–0013 — 18 Releases (v0.7.2 → v0.9.6), Mar 19 – Apr 9

Shipped across 22 days in a single mega-session spanning multiple compactions:

| Version | Feature |
|---------|---------|
| v0.7.2 | Auto-registration, one-note-per-session, Reconstruct skill |
| v0.7.3 | Automatic AI-powered session notes via daemon |
| v0.7.4 | Auto-register on parent match |
| v0.7.5 | Tiered model selection (opus/sonnet/haiku) |
| v0.7.6 | Find claude binary in launchd |
| v0.7.7 | Whisper rules hook |
| v0.7.8 | Strip API key from daemon (prevent billing) |
| v0.8.0 | Topic-based note splitting |
| v0.8.1 | /whisper skill, remove hardcoded defaults |
| v0.8.2 | Reduce topic split sensitivity |
| v0.8.3 | /consolidate skill |
| v0.8.4 | Store TOPIC in HTML comment |
| v0.8.5 | God-note detection, confidence tagging, Louvain communities, query feedback |
| v0.9.0 | 4-layer wake-up, temporal KG, taxonomy, tunnels, mid-session auto-save |
| v0.9.1 | KG backfill CLI, shared kg-extraction module |
| v0.9.2 | Stop-hook first-run safeguard |
| v0.9.3 | Silence stop-hook diagnostics |
| v0.9.4 | Remove exit(2) noise |
| v0.9.5 | Budget-aware advisor mode |
| v0.9.6 | Statusline auto-writes budget to advisor |

### Sessions 0014–0002 — 16 Releases (v0.9.8 → v0.12.2), Apr – Jul 10

Shipped after the v0.9.7 block below. Reconstructed from git history 2026-07-26.

| Version | Feature | Commit |
|---------|---------|--------|
| v0.9.8 | Privacy tags, compact search format, npx install | `1e342c0` |
| v0.9.9 | Advisor mode delegates to haiku instead of hoarding in opus | `112e2f8` |
| v0.9.10 | Cognee-inspired memory architecture | `1f78f40` |
| v0.9.11 | `session-commands` hook for truncation resilience | `64740c2` |
| v0.9.12 | Dispatcher uses `openFederation` directly for kg_search/feedback | `558879a` |
| v0.9.13 | Emit chunk IDs in `memory_search` output | `8537322` |
| v0.9.14 | Plural namespaces, top-level verbs, auto registry-scan | `17492b6` |
| v0.9.15 | AIBroker live sessions, pause all, `/pause` + `/end` skills | `785ec1a` |
| v0.9.16 | Daemon `createHash` import, scan clc fallback, live session filter | `35bff9d` |
| v0.9.17 | AIBroker live-session integration + README session mgmt docs | `8d11545` |
| v0.10.0 | Topic-first redesign + sticky tab titles | `e091b65` |
| v0.10.1 | `sessions clear-names` recovery command | `928fa2e` |
| v0.11.0 | Deduped sessions + universal `pai <name>` (switch/resume/fresh) | `84ff0ac` |
| v0.12.0 | Interactive `pai` picker (search · go · new · cd · finder · remove) | `d3fd578` |
| v0.12.1 | Daemon waits for Postgres instead of silent SQLite fallback | `e06b6d1` |
| v0.12.2 | Never create or decorate empty session notes; `pai project names --all` | `ed1821d` |
| v0.13.0 | Task bus — Todoist provider, ownership resolver, dispatch, `pai task`, Tasks skill | `c46c1bf` |
| v0.13.1 | Share one dispatch deadline with aibroker (`--timeout` passed down) | `6398c91` |

### Session 0003 — Task Bus, Live Dispatch, Coordinated Release (2026-07-31)
- [x] Built the task bus: Todoist as shared cross-session state, `pai:<project>` ownership, dispatch to the owning session
- [x] Todoist provider on **unified API v1** — REST v2 returns **410 Gone**; v1 paginates and returns completed/deleted tasks inline
- [x] Coordinated with the AIBroker session: it shipped `aibroker dispatch` (aibroker@0.8.0), PAI consumes it as an *optional* transport
- [x] Verified live: `delivered` (2/2 to Whazaa), `spawned` (TEKMidian cold start, 10.05s), `skipped`, and graceful degradation on a pre-dispatch CLI
- [x] Registered `reconstruct`, `whisper`, `consolidate`, `advisor` as MCP prompts — exported and stubbed but unreachable via `prompts/get`
- [x] Fixed `.gitignore`: bare `tasks/` matched any depth incl. `src/tasks/`, so the whole module would have committed as nothing while the build still passed locally
- [x] Fixed the 60s-vs-90s timeout mismatch that would have killed slow spawns as unreproducible transport failures
- [x] Filed AIBroker's mailbox silent-drop finding on the bus (`6h9g866Vx7P3GVph`) — the bus's first real use

**Open from this session:**
- [ ] **Write the LinkedIn post** — the reason the work was done; still unwritten
- [ ] **Persist the Todoist token** — currently env-only, so `pai task` fails in any new shell. Run `pai setup` step 16
- [ ] **Triage 6 unrouted findings** in `Mail & Identity 📧` — they match no PAI project, which is exactly what triage is for
- [ ] **File the Postgres silent-outage as a routine** — 144 silent retries over ~2 days with `pai daemon status` reporting "idle"; meets the `Routines 🔁` evidence bar
- [ ] Close or keep the three test tabs: `coogle`, `TEKMidian`, `whazaa` (the last holds a real work order)

### Session 0002 — Glidr Stub-Note Triage, Restore & Empty-Note Guards (2026-07-10)
- [x] Traced 15 gutted Glidr session notes (**not 105** — 90 merely carried the sync footer) to Glidr commit `92b45da`
- [x] Restored 13 bodies from git history (Glidr `3cf00e1`); backfilled the 2 unrecoverable born-stubs (Glidr `7fb1b91`)
- [x] Root-caused the born-stub path to `writeSessionNote` / `spawnSummarizer` returning empty summaries
- [x] Shipped `hasMeaningfulBody` + `hasContent` guards in `src/obsidian/sync/master.ts` and `src/daemon/session-summary-worker.ts` (`1d6d437`) — confirmed working live
- [x] Shipped `pai project names --all` (`a1e9e4f`)
- [x] Persisted findings to `memory/obsidian-master-note-bug.md`
- **Residual:** the original emptier of the 13 real notes was never pinned to PAI code (likely external, not reproducible). Guards make it harmless.

### Session 0017 — v0.9.7
- [x] Advisor mode label in statusline (strict/conserve/critical/normal with color coding)
- [x] 📌 prefix for manually forced modes vs auto-calculated
- [x] Statusline preserves manual mode/forceModel — no longer overwrites with "auto"
- [x] Natural language advisor mode switching ("go easy on the budget", "lock it down", etc.)
- [x] Fixed threshold table drift in advisor prompt (60/80/92 matching whisper-rules.ts)
- [x] Published @tekmidian/pai@0.9.7

### Session 0008 — Stop Hook Continue Fix
- [x] Fixed stop hook to call `updateTodoContinue()` on normal session end — previously only pre-compact hook wrote ## Continue
- [x] Improved fallback text in `updateTodoContinue()` to include working directory instead of generic "check session note"
- [x] Build verified — all 15 hooks compiled clean

### Session 0042 — Auto-Compact Fix & Local AI Research
- [x] Enabled `autoCompactEnabled: true` in `~/.claude.json` — fixes sessions dying at 200k token limit
- [x] Researched Claude Code auto-compaction: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var controls threshold, PreCompact hook exists, no PostCompact yet
- [x] Researched local AI coding assistants: Aider (best CLI), Goose (best agent), Continue.dev (best editor), all via Ollama
- [x] Researched MCP-Ollama bridge pattern — multiple implementations exist (ollama-mcp, ollama-mcp-bridge)
- [x] Researched contextplus (code intelligence MCP) and llm-tldr (code compression) — contextplus complementary, llm-tldr fragile
- [x] Researched Mistral Devstral models: Small 2 (24B, 68% SWE-bench), Devstral 2 (123B, 72.2% SWE-bench)
- [x] Mac Studio RAM analysis: 96GB sweet spot today, 128GB+ for 2-year future-proofing

### Session 0007 — Path Decoder Fix, Active Sessions, Registry Cleanup
- [x] Fixed path decoder bug: `smartDecodeDir()` walks filesystem to decode lossy Claude Code encoding (34→25 skipped projects, 9 recovered)
- [x] Added case-insensitive matching for macOS (TEKmidian → TEKMidian)
- [x] Fixed stale session-registry.json overriding smart decoder
- [x] Cleaned up Devon registry entries after devonthink-mcp → Devon rename
- [x] Built `pai session active` command — detects open Claude Code tabs via JSONL timestamps
- [x] Updated /sessions skill to show active sessions prominently
- [x] Updated FEATURE.md DEVONthink link to github.com/mnott/Devon
- [x] Committed and pushed 4 commits

*Items verified as already implemented during session 0006 code review.*

- [x] **Security review** — Grep pass: zero personal data in tracked source. All `/Users/` use example names. Templates use `${HOME}`.
- [x] **Screenshots to /tmp** — Already in `claude-md.template.md` (lines 103-108): writes to `/tmp/pai-screenshot-*.png`.
- [x] **Setup invokable by prompt (code exists)** — SKILL.md has USE WHEN triggers for "set up PAI", "install PAI", "give Claude a memory". 11-step guide with idempotent checks.
- [x] **User customizations survive PAI updates** — `update.ts` (474 lines): stash → pull → pop → build → restart → CLAUDE.md refresh (checks "Generated by PAI Setup" marker) → registry scan.
- [x] **Idempotent on reinstall (code exists)** — setup.ts checks existing files, offers merge/keep/replace for CLAUDE.md, skips already-done steps.
- [x] **Clean up "New Session.md" placeholders** — Ran `pai session cleanup pai --execute`: 11 deleted, 15 renamed, 40 moved to YYYY/MM/.
- [x] **Empty session notes after kill** — session-stop.sh calls `pai session cleanup --execute`. For SIGKILL, Claude Code hooks may not fire — platform limitation.
- [x] **Intermediate session notes** — pre-compact.sh and session-stop.sh both call `pai session checkpoint` and `pai session handover`. Writes `## Continue` to TODO.md.
- [x] **PAI collaboration on TODO.md** — Already in `claude-md.template.md` (lines 395-406): read-before-write, append-only, user owns checkboxes, atomic writes.
- [x] **SQLite vs PostgreSQL clarity** — Added storage architecture table to ARCHITECTURE.md: Registry = always SQLite, Memory = factory-switchable (SQLite simple / PostgreSQL full).
- [x] **Docker/PostgreSQL survive restart** — `docker-compose.yml` line 7: `restart: unless-stopped`. Daemon uses launchd `KeepAlive`.
- [x] **Embedding process nice** — Daemon calls `setPriority(process.pid, 10)` on startup. macOS has no ionice equivalent.
- [x] **PAI daemon indexing progress view** — `pai daemon logs` fully implemented with `-f` (follow) and `-n` (lines) options. Logs at `/tmp/pai-daemon.log`.
- [x] **PAI as first search** — Already in `claude-md.template.md` (lines 39-53): "PAI-First Search Protocol" with `memory_search → registry_search → project_info → Glob/Grep`.
- [x] **Notifications daemon-routed and mode-switchable** — Full CLI: `pai notify status`, `pai notify set --mode voice`, `pai notify set --enable macos --disable ntfy`, `pai notify test`, `pai notify send`.
- [x] **Whisper multilingual voice (code exists)** — Whisper large-v3-turbo detects language automatically. No explicit config needed.
- [x] `.claude` in git repo — `.gitignore` has `.claude/*` with `!.claude/skills/` exception.
- [x] FEATURE.md comparison — Complete (36 rows). Lives at `FEATURE.md`.
- [x] Templates — Setup skill handles CLAUDE.md template with diff/merge/skip.
- [x] Hooks for handover — pre-compact.sh and session-stop.sh call handover + checkpoint.
- [x] Session cleanup — session-stop.sh calls `pai session cleanup --execute`.

---

## Completed (Archive)

### Session 0006 — TODO Triage, Build Fixes, Session Cleanup, Full Code Review
- [x] Triaged all 20+ open questions from user into 7 categories
- [x] Fixed 4 TypeScript build errors (backup.ts, restore.ts, setup.ts, ipc-client.ts) — clean build
- [x] Security grep pass — zero personal data in tracked source files
- [x] Session cleanup — 11 empty deleted, 15 renamed, 40 moved to YYYY/MM/
- [x] Full code review: verified hooks, update.ts, setup.ts, notify CLI, daemon logs, template, docker-compose
- [x] Added storage architecture documentation to ARCHITECTURE.md
- [x] Resolved 17 TODO items that were already implemented but not marked done

### Session 0001 — PAI Session Navigator
- [x] Built `pai` CLI (1700+ lines Python, Typer + Rich)
- [x] Created `/sessions` skill with 8 workflows
- [x] Built enriched session history at `~/.claude/History/session-history.md`

### PAI Knowledge OS Phases 0-7
- [x] Phase 0: Registry SQLite, CLI, git init
- [x] Phase 1: Session slug generation, rename, registry lookup
- [x] Phase 2: BM25 memory engine (14K+ chunks)
- [x] Phase 2.5: Vector embeddings (bge-small-en-v1.5, 16K+ chunks)
- [x] Phase 3: MCP server (6 tools) registered in ~/.claude.json
- [x] Phase 4: Obsidian bridge (symlinks + topic pages)
- [x] Phase 5: Project lifecycle (promote, move, archive)
- [x] Phase 6: Setup wizard + session cleanup
- [x] Phase 7: Public repo preparation (npm publish as @tekmidian/pai, GitHub)
- [x] Session Router skill (/route command, vector search, auto-route on session start)
- [x] Topic shift detection (BM25 scoring)
- [x] Unified notification framework (ntfy, WhatsApp, macOS, CLI)
- [x] Session handover command (## Continue in TODO.md)
- [x] PAI.md marker file system with YAML frontmatter
- [x] FEATURE.md comparison with Daniel Miessler's Fabric

### Companion Projects
- [x] Whazaa — WhatsApp bridge (IPC architecture, TTS, voice notes, screenshots, /sessions)
- [x] Coogle — Google Workspace MCP daemon (Gmail, Calendar, IPC multiplexing)
- [x] DEVONthink MCP — 28 upstream + 5 custom tools, published @tekmidian/devonthink-mcp
- [x] Statusline — context meter, MCP names, published with PAI@0.2.0
- [x] Fabric migration — native pattern execution, YouTube via Scribe MCP

---

## Key Artifacts

| What | Where |
|------|-------|
| PAI source | `/Users/i052341/dev/ai/PAI/` (dev copy) or `/Users/i052341/Daten/Cloud/Development/ai/PAI/` |
| PAI CLI | `pai` → `dist/cli/index.mjs` |
| PAI daemon | `dist/daemon/index.mjs` (launchd: `com.pai.pai-daemon`) |
| PAI MCP shim | `dist/daemon-mcp/index.mjs` (registered in `~/.claude.json`) |
| PAI registry | `~/.pai/registry.db` (SQLite) |
| Setup skill | `.claude/skills/setup/SKILL.md` |
| Hooks | `src/hooks/pre-compact.sh`, `src/hooks/session-stop.sh` |
| Templates | `templates/claude-md.template.md`, `templates/pai-project.template.md` |
| Notifications | `src/notifications/` (router.ts, 4 providers) |
| FEATURE.md | `FEATURE.md` (36-row comparison with Fabric) |
| Whazaa source | `~/dev/ai/Whazaa/` |
| Coogle source | `~/dev/ai/coogle/` |
| DEVONthink MCP | `~/dev/ai/Devon/` |

---
*Links:* [[Ideaverse/AI/PAI/Notes/Notes|Notes]]

---

*Last updated: 2026-08-04T00:45:40.610Z*
