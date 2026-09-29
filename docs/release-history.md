# Release History

31 releases shipped from v0.7.2 to v0.10.0 (March 19 – May 21, 2026):

| Version | Feature |
|---------|---------|
| v0.7.2 | Auto-registration, one-note-per-session, Reconstruct skill |
| v0.7.3 | Automatic AI-powered session notes via daemon |
| v0.7.4 | Auto-register on parent match |
| v0.7.5 | Tiered model selection (opus/sonnet/haiku) |
| v0.7.6 | Find claude binary in launchd |
| v0.7.7 | Whisper rules hook |
| v0.7.8 | Strip API key from daemon (prevent billing) |
| v0.8.0 | Topic-based note splitting |
| v0.8.1 | /whisper skill, remove hardcoded defaults |
| v0.8.2 | Reduce topic split sensitivity |
| v0.8.3 | /consolidate skill |
| v0.8.4 | Store TOPIC in HTML comment |
| v0.8.5 | God-note detection, confidence tagging, Louvain communities, query feedback |
| v0.9.0 | 4-layer wake-up, temporal KG, taxonomy, tunnels, mid-session auto-save |
| v0.9.1 | KG backfill CLI, shared kg-extraction module |
| v0.9.2 | Stop-hook first-run safeguard |
| v0.9.3 | Silence stop-hook diagnostics |
| v0.9.4 | Remove exit(2) noise |
| v0.9.5 | Budget-aware advisor mode |
| v0.9.6 | Statusline auto-writes budget to advisor |
| v0.9.7 | Advisor mode label in statusline, natural language mode switching |
| v0.9.8 | Privacy tags, compact search format, npx install |
| v0.9.9 | Fix advisor mode to delegate to haiku instead of hoarding in opus |
| v0.9.10 | Cognee-inspired three-tier memory: entity deduplication, graph-completion search, feedback EMA |
| v0.9.11 | Session-commands hook for truncation resilience |
| v0.9.12 | Dispatcher uses openFederation directly for kg_search/feedback |
| v0.9.13 | Emit chunk IDs in memory_search output |
| v0.9.14 | AIBroker live-session integration: `pai sessions` shows live iTerm2 panes |
| v0.9.15 | `pai pause all`: pause every live Claude session at once via AIBroker |
| v0.9.16 | createHash import fix, registry scan clc fallback map |
| v0.9.17 | Switch live-session listing to `sessions` IPC (metadata-only, faster); `--all-tabs` flag |
| v0.9.18 | `pai projects`: moved-project auto-detect, rebind command, active-only default listing |
| v0.10.0 | Topic-first redesign: `pai <topic>` universal resolver, history search, sticky tab titles |
| v0.10.1 | `pai sessions clear-names` recovery command |
| v0.11.0 | Deduped session listing + universal `pai <name>` (switch / resume / fresh) |
| v0.12.0 | Interactive picker: `pai` opens a modal search-and-act selector over projects + sessions (g go · n new · c cd · f finder · d remove); note-keyword filtering; quoted exit-dir path |
