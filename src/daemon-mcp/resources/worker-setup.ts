export const workerSetup = {
  name: "worker-setup",
  uri: "pai://worker-setup",
  description: "Per-project worker setup: pai project init, project checks, panes, .pai/worker.md, status sink, issue claims, denials",
  content: `# Worker setup for a project

Set up: \`pai project init\` (MCP: project_setup) writes .pai/project.yaml and a starter .pai/worker.md; never overwrites without --force; --dry-run writes nothing.
Check: \`pai project health\` (MCP: project_health) ends with "ok|missing - <what> - fix: <command>" lines.

Topics (docs/ in the PAI repo):
- worker-project-setup.md — init flags and the checks
- worker-panes.md — auto-open, host resolution by tty, close on end, pai worker pane --check/--close-ended
- worker-pane-footer.md — model, context, "waiting on", detached job + pai worker wait-on <pid> --log <file>
- worker-snapshots.md — dirty checkout snapshot; Notes/ and TODO*.md excluded
- worker-rules.md — .pai/worker.md (system prompt after the contract, cache-stable, 16 KB)
- project-status-sink.md — .pai/project.yaml: sink todo|forge, anchor, marker, token
- issue-claims.md — pai issue claim/release/claims/stale; assignee claude + label in-progress; released at worker end unless r=~
- worker-denials.md — recorded hook denials, "denied N spec?"
`,
};
