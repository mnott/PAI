export const worker = {
  description: "Run, watch and route subagent workers on configured providers",
  content: `## Worker Skill

USE WHEN delegating subagent work, checking on running workers, or managing worker providers/classes from chat.

### Delegating

The Agent tool is denied when workers are on — delegate with Bash instead:

\`\`\`
pai worker run --label "short task label" --class research \\
  -p '<full, self-contained task spec>' \\
  --allowedTools 'Read,Edit,Write,Bash,Grep,Glob' --output-format json
\`\`\`

- Always run in background (run_in_background: true) and with a timeout.
- Classes: draft (spec writing), plan, implement (default quality), review,
  research (web: add WebSearch,WebFetch), spotcheck (cheap/fast model), simple,
  complex, image. \`--role\` still works as an alias of \`--class\`.
- Anything larger than a one-file change goes through a chain:
  \`pai worker run --chain draft,implement …\` — the draft stage turns the brief
  into a spec file, implement runs with it, \`--chain draft,implement,review\`
  adds a review pass. \`--class spotcheck\` for verification runs.
- The answer is in the \`result\` field of the JSON it prints. Review the diff yourself.
- \`--no-pane\` suppresses the iTerm follow pane; panes open automatically otherwise.
- \`--agent <name>\` runs a definition from ~/.claude/agents/<name>.md (the agent
  library runs on workers: body becomes the system prompt, tools the allowlist,
  model the class).

### Watching

- \`worker_ps\` — running + last finished workers (chains show as trees).
- \`worker_replay\` with id — the transcript of one worker.
- CLI equivalents: \`pai worker ps\`, \`pai worker follow <id>\`.

### Routing

- \`worker_status\` — on/off, active provider, providers, run tally.
- \`worker_providers\` — list/add/update/remove/use/enable/disable/test. Adding
  needs name, base_url, model and a key (key file path, or a raw key which is
  parked in ~/.config/pai/keys/<name>, mode 0600). update changes cost_tier
  (1 cheapest … 5 most expensive) and tags (code, vision, image-gen,
  long-context, fast, reasoning).
- \`worker_classes\` — list/set/unset class → provider[/fast], or constraints
  only (max_cost_tier, require_tags) so auto-routing picks a qualifying provider.
- \`worker_run\` — start a worker or chain from chat; returns the id immediately.
- \`worker_toggle\` — off makes Agent subagents run on Anthropic again.

### Preferences from chat (map the phrase, use the tool, never mention files)

- "use <provider> for image generation" / "route research to <provider>" →
  worker_classes set <class>=<provider>. One line back.
- "prefer the flash model for simple tasks" / "cheap only for drafts" →
  worker_classes set simple|draft=<provider>/fast (or a max_cost_tier). One line.
- "reviews should use a reasoning model" → worker_classes set review with
  require_tags ["reasoning"] (drop the pin if one exists). One line.
- "what handles reviews" / "show the routing table" → worker_classes list
  (plus worker_status for providers). One or two lines.
- Never tell the user to edit a config file — the tools do it.`,
};
