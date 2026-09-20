# Token-waste audit cycle

A recurring review of where this setup spends context tokens. Each cycle
measures, records, fixes what is RED or AMBER, and leaves a run file so the
next cycle can compare against it.

## Files

- `reviewprompt.md` — the prompt to give a fresh session. It names the
  instrument (`pai audit tokens`), the manual checks the instrument cannot do,
  and the output format.
- `runs.md` — one line per run: date, run number, RED/AMBER/GREEN counts, file.
- `YYYY-MM-DD-runN.md` — the full record of one run: the table, the fixes
  applied afterwards, and the proof (before/after readings).
- `YYYY-MM-DD-runN.json` — the same run machine-readable, written by
  `pai audit tokens --record audits/token-waste`.

## How to cycle

1. Start a fresh session in this repository and give it `reviewprompt.md`
   verbatim (`-p "$(cat audits/token-waste/reviewprompt.md)"` or paste it).
2. The session runs `pai audit tokens --record audits/token-waste`. That one
   command measures memory files, hooks, session cache split and context
   growth, spawn overhead, daemon spawns, env and proxy, schedule, skills,
   subagents and MCP servers, then writes the run file and appends to
   `runs.md`.
3. Anything the instrument marks UNKNOWN is measured by hand and added to the
   run file. Never estimate; write UNKNOWN.
4. Read the previous run file. Every RED or AMBER that is still present after
   its fix was applied means the fix did not work: say so in the new run file.
5. Fix RED and AMBER findings. Each fix goes into the run file with the
   reading before and after. Config changes under `~/.claude` get a backup
   under `~/.claude/pai/backups/` first.
6. Re-run the instrument and record the after-readings in the same file.

## Rules

- Measure, do not estimate. Evidence is a number or a path.
- No personal data in these files: home directories are written as `~`,
  project names outside this repository as neutral placeholders.
- The instrument is the source of truth. If a review needs a measurement the
  instrument lacks, add it to `src/audit/` rather than scripting it ad hoc.
- Readings that depend on Claude Code internals (compaction trigger, cache
  TTL, first-turn size) move between releases. Re-measure; never carry a
  number forward as fact.
