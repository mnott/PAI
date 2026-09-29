# Whisper Rules and Privacy Tags

## Whisper Rules

PAI provides a hook that injects user-defined rules into every prompt via `UserPromptSubmit`. Rules survive compaction, `/clear`, and session restarts — they fire on every single turn, making them the most reliable way to enforce behavioral constraints.

**PAI ships the mechanism. You provide the rules.** The file `~/.claude/pai/whisper-rules.md` does not exist by default. Use the `/whisper` skill to manage your rules:

```
/whisper                          — show current rules
/whisper add "NEVER send emails"  — add a rule
/whisper remove 3                 — remove rule #3
/whisper list                     — list with line numbers
```

Or edit `~/.claude/pai/whisper-rules.md` directly — one rule per line, plain text.

**Keep rules focused.** Every rule is injected on every prompt. Too many rules dilute effectiveness and waste tokens. Reserve whisper rules for truly critical constraints that keep getting violated despite being in CLAUDE.md.

The pattern is inspired by [Letta's claude-subconscious](https://github.com/letta-ai/claude-subconscious) approach to persistent context injection.

## Privacy Tags

Wrap any content in `<private>...</private>` tags to exclude it from PAI's memory index. Private content is stripped before chunking — it's never stored, never searched, never surfaced.

```markdown
## API Keys
<private>
STRIPE_KEY=sk_live_abc123
DATABASE_URL=postgres://user:pass@host/db
</private>

## Architecture Notes
The payment system uses Stripe webhooks...
```

The architecture notes get indexed. The API keys don't. Works in session notes, memory files, and any markdown PAI indexes.
