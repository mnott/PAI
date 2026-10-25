# UHP adoptions inside PAI (WP-C)

- Errors: `src/workers/errors.ts`, UHP codes as they are, `pai_` vendor codes for PAI-only conditions; `status.error` and `code=` on `WORKER-END`.
- Idempotency: `pai worker run --idempotency-key K` / MCP `worker_run idempotency_key`; 24 h, `<logDir>/idempotency/`.
- Tracing: `PAI_TRACEPARENT`/`PAI_TRACESTATE` continue a trace; workers get `TRACEPARENT`/`TRACESTATE`; `trace_id` on `WORKER-START`; baggage is never forwarded.
- Redaction: provider keys resolved through `resolveProviderKey` are scrubbed by exact value from the ledger and the final report.
- Resume: claude resumes only when the transcript exists; codex and image start a fresh thread.
- Permissions (C7, measured): workers pass no `--disallowedTools` and no skip-permissions flag, so there is no deny list to move into settings.json; nothing changed.
- Keyless workers (C5, not built): needs the OpenAI-shape router paths (WP-F) first, then a per-run placeholder token the router swaps for the real key.
