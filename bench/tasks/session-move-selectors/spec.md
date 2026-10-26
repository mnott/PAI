Feature request (operator): `pai session move` only accepts a Claude session id prefix, so sessions without a Claude id (or ones I only know by note number) cannot be moved. Extend `moveSession` in src/cli/commands/session/move.ts so the selector can be:
  - a string (Claude id prefix, as today), or a bare all-digit string that is a registry row id (checked first; falls back to prefix matching),
  - an object { project: slug, number: n } selecting the session with that note number in that project (error `No session #<n> in project <slug>` when absent, a clear ambiguity error when several match).
The returned id8 must not crash for a row with no Claude id. Existing behaviour and error messages for id prefixes stay the same.
Optionally wire the CLI (--project/--number, --numbers a,b,c batch) in cmdMove and src/cli/commands/session-notes.ts; the tests only exercise moveSession.
Look at: src/cli/commands/session/move.ts and move.test.ts (existing describe block shows the fixture helpers).
Rule: tests must pass (`npx vitest run src/cli/commands/session/move.test.ts`); never use bun test. Do not commit.
