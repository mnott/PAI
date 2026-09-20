# Token-waste audit runs

One line per run. Counts are RED / AMBER / GREEN in the run's table. Runs 1-3
predate this directory; their records are the token-minimization memory note
and session notes of 2026-09-20, summarised in `2026-09-20-run4.md`.

- 2026-09-20 run1 (07:45-09:30): supervisor prefix 54,629 → 28,837; simple worker 39,875 → 21,179; daemon spawn 29,268 → 14,047. No table kept.
- 2026-09-20 run2 (09:30-10:30): first `pai audit tokens`; hook injections cut (CORE 4,238 → 329, whisper 1,214 → 743); fresh-launch pong 40,797 → 29,869. No table kept.
- 2026-09-20 run3 (10:45-12:30): live ladder decomposition of the 31,603 first turn; worker per-class contracts (10 turns/250k → 2 turns/36k for one `wc`); AG2 reports. No table kept.
- 2026-09-20 run4: 1 RED, 4 AMBER, 8 GREEN — `2026-09-20-run4.md`
- 2026-09-20 run5: 1 RED, 1 AMBER, 8 GREEN — 2026-09-20-run5.md
- 2026-09-20 run6: 0 RED, 2 AMBER, 8 GREEN — 2026-09-20-run6.md
- 2026-09-20 run7: 0 RED, 1 AMBER, 10 GREEN — 2026-09-20-run7.md
- 2026-09-20 run8: 0 RED, 3 AMBER, 9 GREEN — 2026-09-20-run8.md
- 2026-09-20 run9: 0 RED, 1 AMBER, 11 GREEN — 2026-09-20-run9.md
- 2026-09-20 run10: 0 RED, 1 AMBER, 12 GREEN — 2026-09-20-run10.md
- 2026-09-20 run11: 0 RED, 0 AMBER, 13 GREEN — 2026-09-20-run11.md
- 2026-09-20 20:16: run4's `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` change reverted 20 → 80 (backup `~/.claude/pai/backups/settings.json.2026-09-20T2016`). Root cause: the audit rated a 1M-window session against a hardcoded 200k threshold, called the resulting RED "context growth" finding real, and lowered the override to make the 1M session compact near 196k — the user wants the full 1M window. Fixed by deriving window/trigger per session (`src/audit/context-trigger.ts`) instead of assuming 200k; see reviewprompt.md, "Rules the audit may not break".
