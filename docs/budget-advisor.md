# Budget-Aware Advisor Mode

PAI tracks your weekly Claude usage and automatically adjusts subagent model selection to stay within budget. The statusline shows your current mode at a glance.

## How it works

The statusline reads your OAuth usage from the Anthropic API (5-hour and 7-day windows) and writes the weekly budget percentage to `~/.claude/pai/advisor-mode.json`. A whisper-rules hook reads this file on every prompt and injects model-tiering guidance.

## Automatic thresholds

| Budget Used | Mode | Subagent Model | Behavior |
|-------------|------|----------------|----------|
| < 60% | normal | Any | No constraints |
| 60–80% | conservative | Haiku preferred | Escalate to sonnet only if haiku insufficient |
| 80–92% | strict | Haiku only | Minimize spawning, no opus subagents |
| > 92% | critical | Haiku or none | Essential work only, minimize all token usage |

## Statusline display

The advisor mode label appears on the context line:

```
💎 Context: 12K / 1000K (68%) │ 5h: 3% → 13:18 │ 1d: 5% / 8% │ 7d: strict 91% → Fr. 08:00
```

Manually forced modes show a 📌 prefix (e.g. `📌normal 91%`) so you always know whether the mode was auto-calculated or manually set.

## Switching modes

Use `/budget` commands, `/Advisor` skill, or plain language:

```
/budget auto                  — reset to auto (budget-driven)
/budget mode normal           — force normal mode
/budget force haiku           — force all subagents to haiku

/Advisor auto                 — same, via skill (note: capital A)
/Advisor mode strict          — force strict mode

"go full power"               — normal mode (plain language)
"be conservative"             — conservative mode
"lock it down"                — critical mode
"back to auto"                — auto mode
```

Changes take effect on the next prompt — no restart needed.

> **Note:** `/advisor` (lowercase) conflicts with a Claude Code built-in command. Use `/budget` or `/Advisor` (capital A) instead.
