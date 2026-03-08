export const observability = {
  description: "Start, stop, or check the multi-agent observability dashboard",
  content: `## Observability Skill

USE WHEN user says 'start observability', 'stop dashboard', 'restart observability', 'monitor agents', 'show agent activity', or needs to debug multi-agent workflows.

### Commands

\`\`\`bash
~/.claude/Skills/observability/manage.sh start    # Start server + dashboard
~/.claude/Skills/observability/manage.sh stop     # Stop everything
~/.claude/Skills/observability/manage.sh restart  # Restart both
~/.claude/Skills/observability/manage.sh status   # Check status
\`\`\`

### Access

Dashboard UI: http://localhost:5172 | Server API: http://localhost:4000

### What It Monitors

Agent session starts/ends, tool calls across all agents, hook event execution, session timelines. Data source: \`~/.claude/History/raw-outputs/YYYY-MM/YYYY-MM-DD_all-events.jsonl\`.`,
};
