export const worker = {
  description: "Run, watch and route subagent workers on configured providers",
  content: `## Worker Skill

USE WHEN delegating subagent work, checking on running workers, or managing worker providers.

### Delegating

The Agent tool is denied when workers are on — delegate with Bash instead:

\`\`\`
pai worker run --label "short task label" --role research \\
  -p '<full, self-contained task spec>' \\
  --allowedTools 'Read,Edit,Write,Bash,Grep,Glob' --output-format json
\`\`\`

- Always run in background (run_in_background: true) and with a timeout.
- Roles: implement (default quality), research (web: add WebSearch,WebFetch), spotcheck (cheap/fast model).
- The answer is in the \`result\` field of the JSON it prints. Review the diff yourself.
- \`--no-pane\` suppresses the iTerm follow pane; panes open automatically otherwise.
- Panes run under the \`pai-worker\` dynamic profile (default profile's font
  family at \`workers.pane.fontSize\`, default 13); \`pai worker pane <id> --check\`
  reports the pane plus that profile's path, existence and font.

### Watching

- \`worker_ps\` — running + last finished workers.
- \`worker_replay\` with id — the transcript of one worker.
- CLI equivalents: \`pai worker ps\`, \`pai worker follow <id>\`.

### Routing

- \`worker_status\` — on/off, active provider, providers, run tally.
- \`worker_providers\` — list/add/remove/use/enable/disable/test. Adding needs
  name, base_url, model and a key (key file path, or a raw key which is
  parked in ~/.config/pai/keys/<name>, mode 0600).
- \`worker_roles\` — list/set/unset role → provider[/fast].
- \`worker_toggle\` — off makes Agent subagents run on Anthropic again.`,
};
