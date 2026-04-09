export const advisor = {
  description:
    "Manage budget-aware advisor mode — control model tiering for subagents based on weekly usage",
  content: `## Advisor Mode Management

USE WHEN user says 'advisor', 'budget mode', 'set advisor', 'save budget', '/advisor', 'how much budget', OR wants to control model tiering for subagents.

Advisor mode controls which models subagents use, based on weekly budget consumption.

### Configuration

The config file is at \`~/.claude/advisor-mode.json\`:
\`\`\`json
{
  "weeklyBudgetPercent": 90,
  "mode": "auto"
}
\`\`\`

### Usage

- \`/advisor\` — show current mode and budget
- \`/advisor set <percent>\` — set weekly budget percentage (triggers auto mode calculation)
- \`/advisor mode <normal|conservative|strict|critical>\` — force a specific mode
- \`/advisor auto\` — reset to auto mode (derives from weeklyBudgetPercent)
- \`/advisor force <model>\` — force all subagents to use a specific model (haiku/sonnet/opus)
- \`/advisor reset\` — remove the config file (no advisor guidance injected)

### Mode Thresholds (auto mode)

| Budget Used | Mode | Subagent Model | Behavior |
|-------------|------|----------------|----------|
| < 70% | normal | Any | No constraints |
| 70-85% | conservative | Haiku preferred | Escalate to sonnet only if haiku insufficient |
| 85-95% | strict | Haiku only | Minimize spawning, no opus subagents |
| > 95% | critical | Haiku or none | Essential work only, minimize all token usage |

### Workflow

**Show current status:**
Read \`~/.claude/advisor-mode.json\`. Display the mode, budget percentage, and what model constraints are active.

**Update budget percentage:**
The user reads their weekly budget from the statusline (e.g., "7d: 63% → Fr. 08:00").
Write the percentage to \`weeklyBudgetPercent\` in the config file.
If mode is "auto", the whisper hook will compute the appropriate tier.

**Force a mode:**
Set \`mode\` to the desired value. Overrides auto calculation.
Useful when the user wants to be aggressive (normal) or cautious (strict) regardless of actual budget.

**Force a model:**
Set \`forceModel\` to "haiku", "sonnet", or "opus". ALL subagents will use this model.
Useful for testing or when the user knows exactly what they want.

### Integration

The advisor config is read by the whisper-rules hook on every prompt. Changes take effect immediately — no restart needed. The guidance appears as an ADVISOR MODE line in the system-reminder alongside the whisper rules.
`,
};
