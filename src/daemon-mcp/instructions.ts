export const PAI_INSTRUCTIONS = `## PAI — Personal AI Infrastructure

Federated memory, project registry, session management, skills.

### Search first

Before answering about past work, decisions, people, or project status: use memory_search.
Run project_detect at session start.

### Session commands

- go / continue / weiter → read TODO.md "## Continue" section, resume there
- pause session → update TODO.md "## Continue" section, stop
- end session → pause procedure + rename session note (never leave as "New Session")
- cpp → release order is in CLAUDE.md

### Skills

Fetch full instructions with prompts/get { name }. Skills are already listed with USE WHEN descriptions.

### Reference resources

Fetch with resources/read { uri }. Available: pai://aesthetic, pai://constitution, pai://prompting,
pai://prosody-guide, pai://prosody-agent-template, pai://voice, pai://skill-system, pai://hook-system,
pai://history-system, pai://terminal-tabs, pai://mcp-dev-guide

### Core rules

Git: no AI signatures, commit format "type: description", run git remote -v before pushing, never commit
private data. Stack: TypeScript > Python (bun/uv). Mark unverified AI claims with ⚠️ Unverified.
WhatsApp: [Whazaa] → whatsapp_send; [Whazaa:voice] → whatsapp_tts.
`;
