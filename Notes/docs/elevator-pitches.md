# PAI Elevator Pitches

## Directory Pitch (1 paragraph)

PAI Knowledge OS gives Claude Code a memory. Every session is automatically documented — a background daemon reads the conversation transcript, combines it with your git history, and writes structured session notes in real time. When you change topics mid-session, PAI detects the shift and creates a new note. No manual journaling, no "pause session" commands. You start a new session and Claude already knows what you built yesterday, what decisions you made, and where you left off. Federated search across all your projects, Obsidian vault integration, and 21 skills for everything from weekly reviews to session reconstruction. Open source, runs entirely local, no cloud dependency.

---

## LinkedIn Post

**I gave Claude Code a memory. It changed everything.**

The problem: every Claude Code session starts cold. No idea what you built yesterday. You re-explain everything, every time.

So I built PAI — a background daemon that automatically documents every session. It reads the conversation transcript, combines it with git history, and writes structured notes: what was built, what decisions were made, what failed, what's next.

The interesting part: **it detects topic changes mid-session.** If you start debugging audio, then pivot to a Flutter rewrite, you get two separate notes — automatically. No manual tagging, no "pause session."

Under the hood:
- Daemon spawns headless Claude (using your Max plan) to summarize
- Topic detection via Jaccard word similarity
- Whisper rules inject critical constraints on every prompt (survives compaction)
- 21 skills: weekly reviews, session reconstruction, note consolidation
- Federated search across all projects (BM25 + vector + cross-encoder reranking)

Everything runs locally. No cloud. No API charges.

Open source: github.com/mnott/PAI

#ClaudeCode #AI #DeveloperTools #ProductivityTools #OpenSource

---

## X/Twitter Post

Claude Code forgets everything between sessions. So I built PAI — a daemon that automatically writes session notes from conversation transcripts + git history.

The cool part: it detects topic shifts mid-session and creates separate notes. Debug audio → pivot to Flutter rewrite → two notes, zero manual effort.

21 skills, federated search, Obsidian integration. All local, all open source.

github.com/mnott/PAI

---

## X/Twitter Thread (for deeper engagement)

1/ Claude Code has a memory problem. Every session starts from zero — no idea what you built yesterday.

I built PAI Knowledge OS to fix this. Here's what it does 🧵

2/ A background daemon watches your sessions. On every compaction (auto-triggered as context fills up), it reads the JSONL transcript + git log and spawns a headless Claude to write a real session note.

Not a template. Not metadata. Actual decisions, errors, code snippets, what failed.

3/ The headline feature: topic-based note splitting.

If you start debugging iOS audio, then pivot to a Flutter rewrite mid-session, PAI detects the shift and creates a NEW note. Multiple notes per day, each focused on one topic.

4/ It also has "whisper rules" — critical constraints injected on every single prompt. Survives compaction, /clear, session restarts.

Think of it as CLAUDE.md that can never be forgotten.

Inspired by Letta's claude-subconscious, but built as infrastructure, not a plugin.

5/ 21 skills ship with it:
- /review — synthesize your week
- /reconstruct — recover notes from old JSONL transcripts
- /consolidate — clean up duplicate notes
- /whisper — manage persistent rules
- /plan — priorities from open TODOs

6/ Search is federated across all your projects. BM25 keyword + vector semantic + cross-encoder reranking + recency boost.

"What did we decide about the database schema?" finds it even if you used different words.

7/ Everything runs locally. No cloud. No API charges (uses your Max plan). Obsidian vault integration for knowledge management.

Open source: github.com/mnott/PAI

---

## X Reply Template (when someone posts about Claude Code memory/context issues)

Built something for exactly this — PAI Knowledge OS. Background daemon that automatically writes session notes from JSONL transcripts + git history. Detects topic shifts mid-session and creates separate notes. Everything local, open source: github.com/mnott/PAI

---

## X Reply Template (when someone posts about AI coding assistant productivity)

We solved the "Claude forgets everything" problem with PAI — a daemon that auto-documents every session from conversation transcripts. Topic-aware note splitting, whisper rules that survive compaction, federated search across projects. Open source: github.com/mnott/PAI

---

## X Reply Template (when someone posts about note-taking/knowledge management for developers)

If you use Claude Code, check out PAI — it auto-generates session notes from your conversation transcripts + git history. No manual journaling. Detects topic changes and creates separate notes. Integrates with Obsidian. Open source: github.com/mnott/PAI
