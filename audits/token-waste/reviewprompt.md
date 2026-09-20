Audit this setup for token waste. Measure first, report second, fix third.

Scripting: this repository carries the instrument. Run it from the repository
root before anything else, and read `audits/token-waste/runs.md` plus the
newest run file there so you know what the previous run found and fixed:

    pai audit tokens --record audits/token-waste

It writes `audits/token-waste/<date>-run<N>.md` and `.json` and appends a line
to `runs.md`. Its subcommands cover the items below one by one:
`files`, `hooks`, `session`, `spawn`, `daemon`, `env`, `schedule`, `skills`,
`subagents`, `mcp`, `ladder --live` (billed, only when asked). Use them for
detail; use your shell and file tools only for what the instrument marks
UNKNOWN, and add that measurement to `src/audit/` afterwards so the next run
does not need the shell. Do not run or paste `/context`: run in-session it
cost 9,139 billed tokens on the turn it landed in run 11 (raw stdout with
ANSI codes and the expanded per-tool table are both sent, and both ride every
later turn); before the first API call its total under-reports (17.6k shown,
37,559 billed in run 10). `session` prints the first-turn breakdown and
`session --turn <n>` attributes any later turn's growth.

1. MEMORY
   Find every CLAUDE.md in scope: this project, parent directories, the user
   level one, and anything pulled in with @imports. Report each file's size in
   tokens. Flag any single file over 5k and any total over 10k.

2. TOOLS
   List connected MCP servers and how many tools each exposes. State plainly
   whether tool deferral is ACTIVE or NOT. Then check for a proxy or gateway
   (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, any gateway variable) and say so
   loudly if you find one, because routing through a proxy silently turns
   deferral off and nothing warns you.

3. MODEL
   Report the current model and effort level and where each is set. Flag any
   mode that changes model automatically during a session, because every
   switch rebuilds the whole cache.

4. HOOKS
   List any PreToolUse hooks that rewrite noisy commands to produce less
   output. If there are none, say so, because unfiltered test and build output
   lands in context verbatim and is re-sent for the rest of the session.

5. SUBAGENTS
   List every agent file in the project and user agent directories. For each,
   report whether it sets an explicit model in frontmatter or inherits the
   main session's model.

6. SCHEDULED WORK
   List every cron, scheduled task and background job with its interval.
   Compare each interval against the prompt cache lifetime. Flag every one
   whose interval is longer, because those miss cache on every single fire.

7. CACHE
   Parse the newest session log under the projects directory. For every
   assistant turn, sum usage.cache_read_input_tokens,
   cache_creation_input_tokens, input_tokens and output_tokens. Report each as
   a percentage of the total. Also report the context size on the first turn
   and on the last turn, the average and maximum context per turn, and how
   many turns ran above 200k.

Output one table, sorted by cost, highest first:

   FINDING | SEVERITY | EVIDENCE | WHAT IT IS COSTING ME

Severity is RED, AMBER or GREEN. Evidence is a number or a file path, never an
adjective. Then one final line: the single highest-leverage change I should
make. One line, nothing else.

Then fix every RED and AMBER finding as far as possible, root cause not
symptom, with the reading before and after each fix in the run file. Back up
any file under ~/.claude before changing it. Config that the instrument
cannot yet check gets a check added to `src/audit/`. Do not commit.

Rules: measure, do not estimate. Write UNKNOWN rather than guessing. Compare
against the previous run file; a finding that survived its fix is reported as
"fix did not hold". No personal data in the run file: home directory as `~`.

## Rules the audit may not break

Never lower `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` below 80, and never treat a 1M-
window session as a 200k one. The user wants the full window. A RED "context
growth" finding on a 1M-window session is a finding about the instrument
(it is rating the session against the wrong yardstick), not about the
session — fix the instrument's derivation, not the session's configuration.
