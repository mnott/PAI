Parse the advisor command arguments: $ARGUMENTS

Execute exactly ONE of these based on the arguments:

- No args → Read `~/.claude/advisor-mode.json` and display current mode, budget percentage, and active constraints
- `auto` → Write `{"weeklyBudgetPercent":CURRENT,"mode":"auto"}` to `~/.claude/advisor-mode.json` (preserve current weeklyBudgetPercent, set mode to auto)
- `mode normal|conservative|strict|critical` → Write the mode to `~/.claude/advisor-mode.json` (preserve weeklyBudgetPercent)
- `force haiku|sonnet|opus` → Write `forceModel` to `~/.claude/advisor-mode.json` (preserve weeklyBudgetPercent and mode)
- `set <number>` → Write the number as weeklyBudgetPercent, set mode to auto
- `reset` → Delete `~/.claude/advisor-mode.json`

After writing, read the file back and confirm what changed. Changes take effect on the next prompt.
