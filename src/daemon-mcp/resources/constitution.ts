export const constitution = {
  name: "constitution",
  uri: "pai://constitution",
  description: "PAI system constitution — founding principles, architecture, and directory structure",
  content: `# PAI System Constitution — Summary

The foundational philosophy, architecture, and operations of PAI (Personal AI Infrastructure).

## Eight Founding Principles

1. **Scaffolding > Model** — System architecture matters more than the underlying model. Build the scaffolding first.
2. **As Deterministic as Possible** — Favor predictable, repeatable outcomes. CLI tools over ad-hoc prompting.
3. **Progressive Disclosure** — Show what's needed, when it's needed. Routing tables in instructions; full content in prompts.
4. **Skills as Containers** — Each skill is a self-contained unit with SKILL.md, workflows/, and tools/.
5. **CLI-First** — Every capability should be accessible from the command line before being wrapped in prompts.
6. **Two-Tier MCP** — Thin routing shim (daemon-mcp) + full capability daemon. Never merge them.
7. **History as Memory** — All work is captured automatically to \${PAI_DIR}/History/. Work normally, docs handle themselves.
8. **Fail Gracefully** — Hooks and automations must never block the AI. Always exit 0.

## Architecture Layers

\`\`\`
User
  └── Claude Code (+ PAI MCP shim)
        └── PAI Daemon (IPC socket)
              ├── federation.db (SQLite — memory, projects, sessions, vault)
              ├── Embedding model (singleton)
              └── Project registry
\`\`\`

## The Four Primitives

| Primitive | Location | Purpose |
|-----------|----------|---------|
| Memory | \${PAI_DIR}/projects/*/Notes/ | Session notes, todos |
| Skills | ~/.claude/Skills/ | Workflow instructions |
| History | \${PAI_DIR}/History/ | Automated capture |
| Config | ~/.config/pai/ | Agent preferences, voices |

## Two-Tier MCP Strategy

- **daemon-mcp (shim)**: Thin proxy. Handles tool routing via IPC. Serves prompts and resources.
- **daemon**: Full capability server. Holds DB connections, embedding model, search engine.

## Directory Structure

\`\`\`
~/.claude/
├── Skills/
│   ├── CORE/          # PAI core skill (auto-loaded at session start)
│   └── user/          # Personal custom skills (gitignored)
├── Hooks/             # Event-driven automation scripts
├── History/           # Universal Output Capture System
│   ├── Sessions/
│   ├── Learnings/
│   ├── Research/
│   ├── Decisions/
│   └── Execution/
└── projects/          # Claude Code session data
\`\`\`

## Security Model

- PRIVATE PAI (\${PAI_DIR}/): Contains all personal data. Never make public.
- PUBLIC PAI (~/Projects/PAI/): Sanitized code only. Reviewed before every commit.
- Rule: Run \`git remote -v\` before every push.
`,
};
