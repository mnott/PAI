# pai CLI (`src/cli`)

Designed around what is done every day: **find a session, start it, make sure it runs where you want.**
Everything else exists (old names unchanged for hooks, skills and MCP) but is not on the first screen: `pai more`.

## Screens (designed first, built exactly like this)

`pai` — picker. Newest first, type to filter, arrows, Enter. Not a terminal: the same table, plain, exit 0.

```
filter

  Name                   Project   Last active  Last used on             Last message
  ─────────────────────  ────────  ───────────  ───────────────────────  ──────────────────────────
› 20 - Webseiten         web       2d ago       opus-5.5 (anthropic)     keepalive
  api-spike              api       3h ago       glm-5.3 (glm)            fix the retry loop
  notes                  notes     5d ago       k3 (kimi)                [red: kimi: at limit, 100% until 16:15]

↑↓ move · type to filter · Enter open · Esc quit
```

`pai NAME` — launch screen, six lines, never a cryptic question (exact name wins; several matches open the picker pre-filtered; none says so and names the closest):

```
Session       "20 - Webseiten"   last active 2d ago
Last message  "keepalive"
Last ran on   opus-5.5 (anthropic) with workers on glm-fast
> Enter  Continue exactly like last time
  s      Choose a different setup
  n      Start fresh (same name, new conversation)
```

`s` — setup chooser (`pai setups` prints the same table):

```
  #  Setup                     Orchestrator          Workers          Status
  ─  ────────────────────────  ────────────────────  ───────────────  ───────────────────────────────
› 1  Last time                 opus-5.5 (anthropic)  glm-fast (glm)   70% used
  2  anthropic only            sonnet (anthropic)    anthropic (haiku) ok
  3  anthropic + kimi workers  sonnet (anthropic)    kimi-fast (kimi) kimi: at limit, 100% until 16:15
  4  glm only                  glm-5.3 (glm)         glm-fast (glm)   70% used
```

Before launch, always one explicit line: `Starting "NAME": orchestrator opus-5.5 (anthropic), workers glm-fast (glm)`.
A different provider than the conversation was made with is normal, not a question: it prints
`Conversation history carries over to glm-5.3.` and goes. A provider at its limit shows red in the Status column;
Enter on the launch screen refuses it in plain words and points to `s`; choosing it in the chooser (or `--with`) is the deliberate act.

## Provider precedence (deterministic, no silent fallback)

1. An explicit setup/flag (`--with SETUP`, or `--provider` on the scripting commands) always wins.
2. Otherwise what you picked on the launch screen (`s`).
3. Otherwise "Last time": the provider the conversation last ran on.
4. Otherwise the active provider (`pai providers use NAME`), else plain anthropic.
5. A provider that is unavailable is an error naming the ones that are — never another provider quietly. The worker side of a setup is applied with the same `useProvider` as `pai providers use`.

## Root causes found (old CLI)

- **`pai NAME --provider X` kept the old provider.** `--provider/--model` are declared on the bare default command but only the
  picker read them; `launchSession` called `launchInDir(dir, name, {resumableUuid, dryRun})` and dropped them, and
  `resolveResumeRoute` then pinned the provider the transcript ran on (or the active one). Repro: `pai <name> --resume --dry-run --provider kimi`
  printed `route: local30x6`. Here the flag is read first (`provider-choice.ts`, tested).
- **"Warning: Detected unsettled top-level await" on Ctrl-C.** The old entry `await`s `parseAsync`; a cancelled `readline.question`
  never resolved, the event loop emptied, Node printed the warning. Here every prompt settles on Esc, Ctrl-C and input EOF
  (resolves null), SIGINT exits 130 with the cursor restored, and the entry ends with an explicit `process.exit(code)`.

## Library choice

Parser and help: none added — `define.ts` command objects + a ~100-line parser (`parse.ts`) + chalk (already a dependency).
Commander cannot print our error wording (did-you-mean, missing-argument Usage line) without replacing most of its output.
Prompts: no prompt library — the picker needs aligned multi-column rows with a live filter, which prompt libraries do not render;
`lib/picker.ts` (~150 lines, no dependency) has a pure state machine and view, and runs against a fake TTY in tests.

## Layout

- `define.ts` — `CommandDef` (name, summary, description, args, options, examples, seeAlso, run) and the shared flags (`OPT`).
- `help.ts` — renderer (Usage / Arguments / Options table / Examples / See also), overview, `pai more`, Markdown, did-you-mean, colour (TTY only, `NO_COLOR` honoured).
- `parse.ts`, `run.ts` — parsing and dispatch; exit codes 0 / 1 (failed, with next command) / 2 (usage) / 130 (cancelled).
- `registry.ts` — groups. `commands/` — one file per group (`root`, `session`, `providers`, `setups`, `meta`).
- `lib/` — `harness.ts` (the launch command, via `buildLaunchPlan` shared with `pai launch`), `provider-choice.ts`, `setups.ts`, `health.ts`, `picker.ts`, `session-scan`, `launch`, `aibroker-client`, `exit`, `exit-dir`, `utils`.
- `pai doc [--out FILE]` writes the Markdown reference from the same definitions.
- Errors: one sentence plus `Next: <exact command>`; stack traces only with `PAI_DEBUG=1`.
