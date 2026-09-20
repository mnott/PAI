export const providers = {
  description: "List every configured provider and model, mark the one this session runs on, and explain how to switch",
  content: `## Providers Skill

USE WHEN user says /providers, /models, /provider, what providers exist, which models are configured, show providers, what model this session is on, switch provider, OR asks which provider or model this session or the harness is currently running on.

### The constraint that matters

A running \`claude\` process cannot switch provider — its base URL and auth are fixed for the life of the process. Claude Code's own \`/model\` command only ever lists the models of whatever endpoint THIS process was started against (plain Anthropic if started plainly, a provider's models if started through it). Switching provider always means starting a NEW session, with \`pai launch\`.

### Procedure

1. Run:

   \`\`\`bash
   pai launch --list --current
   \`\`\`

2. Print its output to the user **verbatim** — it already lists every enabled provider (built-in \`anthropic\` first) with its default/fast/image models, numbered, marks the workers.yaml \`active\` provider, marks the row matching THIS session own provider/model when it can be determined (falls back to (session default) rather than guessing), and ends with a line explaining how to switch.

3. Do not add a summary of the table — the command output is the answer.

### Notes

- Provider/model detection is env-based (\`ANTHROPIC_BASE_URL\` against workers.yaml, and \`ANTHROPIC_DEFAULT_SONNET_MODEL\` when set) — a best-effort read of THIS process own environment, not a live API call.
- To actually start on a different provider: \`pai launch --provider <name> --model <model>\` (model defaults to that provider default). \`pai launch\` alone, in a terminal, offers a numbered picker instead.
- \`pai worker providers\` is the config-management surface (add, remove, enable, disable, use) — this skill is read-only, for what is configured and what this session is on.`,
};
