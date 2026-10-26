---
name: Tests
description: "Clean up a project's tests down to the governed core and keep suites from growing again (tests/KEPT.md: fix evidence, security guard, external contract; unit, UI/simulator, snapshot and run outputs). USE WHEN user says 'clean up tests', 'prune tests', 'test cleanup', 'too many tests', 'test governance', 'clean up testing', OR a notice says a project's suite outgrew its core."
---

## Tests Skill

USE WHEN user says 'clean up tests', 'prune tests', 'test cleanup', 'too many tests', 'test governance', OR a `[pai tests]` growth notice says to run `clean up tests`.

Tests stay only with evidence, listed in `tests/KEPT.md`: (a) a real fix they guarded, (b) a security or destructive-operation guard, (c) an external contract (wire format, schema migration, CLI output, docs-sync). Everything else, including UI/simulator test runs, snapshot baselines and `.xcresult`/recordings/screenshots, is one-time and scratched.

### Steps

1. Call MCP `tests_audit` with `repo` = the project path (CLI: `pai tests audit --repo <path>`). Read-only. Show the user the counts, the KEEP list with evidence, the file-count trend.
2. Call `tests_prune` without `apply` to show the plan. Questionable KEEP/DROP calls: ask the user.
3. On the user's go, call `tests_prune` with `apply=true`. A worker prunes on its own branch and makes one commit; it does not merge. Tell the user the worker id; they land it (`pai worker merge`).

Never run a project's full test suite or a simulator run to decide this.
