# PAI Agent Preferences (Personal Configuration)

Copy this file to `~/.config/pai/agent-prefs.md` and customize for your workflow. This file is **NOT** committed to any repository and contains your personal preferences.

---

## Your Identity

```markdown
- Name: [Your Name]
- Role: [Your professional role, e.g., "Senior Software Engineer", "CTO", "Product Manager"]
- Location: [City/Timezone, optional]
- Default Language: [en, de, fr, etc.]
```

**Why this matters**: Agents use this context when generating personalized recommendations and documentation. It helps them understand your expertise level and tailor responses accordingly.

---

## Directory and Search Restrictions

**CRITICAL**: These restrictions prevent expensive, timeout-prone searches.

```markdown
## Never Search (Home Directory)
- ~
- ~/Library
- ~/Desktop (usually cluttered)
- ~/Downloads (usually temporary)

## Always Use Specific Paths
- ~/Projects       (code repositories)
- ~/.claude        (Claude Code configuration)
- ~/dev            (active development)
- ~/.config        (system configuration)
```

**Rule**: If you need to search, pick the most specific subdirectory possible.

**Example**: Instead of `grep -r "TODO" ~`, use `grep -r "TODO" ~/dev`.

---

## Project-Code Directory Mappings

Map your Obsidian projects to code repositories. This helps end-session automation find the right directories to commit and push.

```markdown
| Obsidian/Notes Project | Code Directory | Notes |
|------------------------|----------------|-------|
| PAI Knowledge OS       | ~/dev/ai/PAI   | Main project |
| My App                 | ~/dev/my-app   | Primary development |
| Blog                   | ~/projects/blog| Publishing project |
```

**During end-session cleanup**, these mappings tell PAI which code directories to commit changes to.

**Format**: Obsidian vault name (or note project name) → absolute path to code directory.

---

## Notification Preferences

Configure how PAI notifies you of important events (long-running tasks, completions, errors).

```markdown
## Primary Notification Channel
- Method: WhatsApp (via Whazaa MCP)
- Contact: [your phone number or contact name]

## Fallback Channel (when WhatsApp unavailable)
- Method: ntfy.sh (cloud pubsub)
- Topic: [your-private-ntfy-topic]  # Must be >20 chars or use cryptographically random

## Important Events to Notify
- [ ] Long-running task started (>30 seconds)
- [ ] Task completed successfully
- [ ] Task failed or encountered error
- [ ] Manual intervention required
```

**Security Note**: ntfy.sh topics are publicly readable if someone guesses the URL. Use a long, random topic name or disable cloud notifications if sensitive.

**Configuration**: Set `NTFY_TOPIC` and `NTFY_URL` environment variables if using ntfy.sh fallback.

---

## Voice Configuration

Optional: Configure voice output for agents (WhatsApp voice notes, local speakers).

### ElevenLabs Setup (Optional)

```markdown
API Key: [set via ELEVENLABS_API_KEY environment variable]
Default Voice ID: [your preferred voice ID, e.g., "21m00Tcm4TlvDq8ikWAM"]
```

Get your API key from https://elevenlabs.io/app/keys (requires account).

### Voice Assignments by Agent

```markdown
Agent Type       | Voice ID / Name           | Use Case
-----------------|---------------------------|-----------------------------------
main             | [main-voice-id]          | General responses, default
intern           | [intern-voice-id]        | Quick summaries, status updates
engineer         | [engineer-voice-id]      | Code reviews, technical details
architect        | [architect-voice-id]     | System design, high-level planning
researcher       | [researcher-voice-id]    | Research summaries, findings
```

**Alternative**: Use Kokoro TTS (local, free):
- Available voices: `af_bella`, `af_nova`, `bm_george`, `bm_daniel`, `bf_emma`, etc.
- No API key needed — runs entirely locally
- Better for privacy-sensitive workflows

**Configuration**: Store voice preferences in `~/.config/pai/voices.json` (see voices.example.json).

---

## Git Commit Rules

Configure how changes are committed to code repositories.

```markdown
## Commit Signatures
- Include AI signature: false (default)  # "Co-Authored-By: Claude <...>"
- Verify commits: false (default)

## Commit Message Format
- Style: conventional commits (feat:, fix:, refactor:, docs:, test:)
- Include scope: true (e.g., "feat(auth): add JWT validation")
- Include ticket number: [optional, e.g., "#123"]

## Auto-Commit Behavior
- Commit after tests pass: true
- Commit after code review: false (manual review first)
- Require branch protection: false
```

**Conventional Commits Examples**:
- `feat(api): add user authentication endpoint`
- `fix(database): resolve connection pooling issue`
- `refactor(ui): simplify button component logic`
- `docs(readme): update installation instructions`
- `test(auth): add JWT validation tests`

---

## Code Quality Preferences

Configure code review and quality standards.

```markdown
## Testing Requirements
- Minimum test coverage: 80%
- Test types required: unit, integration, e2e
- Test runner: [jest, vitest, pytest, etc.]

## Code Style
- Linter: [eslint, ruff, pylint, etc.]
- Formatter: [prettier, black, autopep8, etc.]
- Max line length: 100
- Tabs vs Spaces: spaces (2 or 4?)

## TypeScript/JavaScript
- Strict mode: true
- Package manager: bun (default)
- Node version: [18, 20, 22, etc.]

## Python
- Python version: [3.11, 3.12, etc.]
- Package manager: uv (default) or pip
- Type checking: pyright or mypy
```

---

## Language and Framework Preferences

```markdown
## Language Preferences (ranked)
1. TypeScript / JavaScript (primary)
2. Python (data/ML work)
3. [Other language]

## Web Framework
- Backend: [Express, Fastify, Django, FastAPI, etc.]
- Frontend: [React, Vue, Svelte, etc.]
- Build tool: [Vite, Webpack, esbuild, etc.]

## Database
- Primary: [PostgreSQL, MySQL, SQLite, etc.]
- Cache: [Redis, Memcached, etc.]
- Vector DB: [Pinecone, Supabase pgvector, etc.]

## Cloud Platform
- Primary: [AWS, Azure, GCP, etc.]
- Preferred services: [Lambda, CloudRun, etc.]
```

---

## Workflow Preferences

```markdown
## Planning and Documentation
- Use plan mode for tasks with 3+ steps: true
- Write technical specs before implementation: true
- Update task progress in real-time: true

## Task Management
- Task file location: tasks/todo.md
- Lesson file location: tasks/lessons.md
- Review lessons at session start: true

## Code Review Standards
- Auto-approve trivial changes: false
- Require spotcheck for parallel work: true
- Demand elegance for non-trivial changes: true

## Verification Before Completion
- Prove it works with tests/demo: true
- Check logs and error handling: true
- Measure performance improvements: true
```

---

## Custom Preferences

Add any additional personal preferences or workflow rules:

```markdown
## Custom Rules
- [Your rule 1: e.g., "Never install packages globally without approval"]
- [Your rule 2: e.g., "Always backup databases before migrations"]
- [Your rule 3: e.g., "Use feature branches for all changes"]

## Avoid These Patterns
- [Anti-pattern 1: e.g., "Don't use eval() in JavaScript"]
- [Anti-pattern 2: e.g., "Don't skip error handling for brevity"]

## Team Standards
- [Team rule 1]
- [Team rule 2]

## Security Requirements
- [Requirement 1: e.g., "All API keys in .env files, never in code"]
- [Requirement 2: e.g., "Sanitize user input before database queries"]
```

---

## Example Customized Configuration

Here's a sample filled-in configuration:

```markdown
# My PAI Agent Preferences

## Your Identity
- Name: Alice Chen
- Role: Senior Full-Stack Engineer
- Location: San Francisco, PST
- Default Language: en

## Directory Restrictions
Never Search: ~, ~/Library, ~/Downloads
Always Use: ~/dev, ~/Projects, ~/.claude

## Project-Code Directory Mappings
| Obsidian Project | Code Directory |
|------------------|----------------|
| Work Notes | ~/dev/company-product |
| Learning | ~/projects/learning |
| PAI | ~/dev/ai/PAI |

## Notification Preferences
- Primary: WhatsApp to my number
- Fallback: ntfy.sh/alice-projects-82934

## Voice Configuration
- Default: Kokoro (bm_george)
- Engineer: Kokoro (bm_daniel)

## Git Commit Rules
- Format: conventional commits
- Include scope: true
- AI signature: false

## Language Preferences
1. TypeScript / Node.js
2. Python (data pipelines)

## Workflow Preferences
- Use plan mode: always
- Verify before completion: always
- Task file: tasks/todo.md
```

---

## How to Use This File

1. **Copy to config directory**:
   ```bash
   cp ~/dev/ai/PAI/templates/agent-prefs.example.md ~/.config/pai/agent-prefs.md
   ```

2. **Customize for your workflow**: Edit `~/.config/pai/agent-prefs.md` with your settings.

3. **Make it executable** (optional):
   ```bash
   chmod 600 ~/.config/pai/agent-prefs.md  # Restrict permissions if sensitive
   ```

4. **Load in your scripts**: Your PAI daemon/CLI reads this automatically on startup.

---

## File Permissions and Privacy

This file contains personal preferences and may reference sensitive information:

```bash
# Recommended permissions (user read/write only)
chmod 600 ~/.config/pai/agent-prefs.md
```

Keep it **out of version control** — add to `.gitignore`:
```
~/.config/pai/
.config/pai/
```

---

## Updating Your Preferences

Preferences can be updated at any time:

- **Session active**: Changes take effect on next agent spawn
- **No daemon restart required**: PAI reads the file fresh on each operation
- **Version control**: Use git to track changes if desired in a private repo

---

## Questions and Troubleshooting

**Q: What if I leave a field blank?**
A: PAI uses sensible defaults (see daemon configuration). Your preferences override defaults when set.

**Q: Can I use environment variables instead?**
A: Yes. PAI checks environment variables first, then falls back to this file.

**Q: How does this relate to ~/.claude.json?**
A: `.claude.json` is for Claude Code and MCP server configuration. This file is for PAI-specific agent preferences.

**Q: What if I delete this file?**
A: PAI will use defaults. You can always recreate it from this template.
