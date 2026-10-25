# UHP engine

A provider with `engine: "uhp"` runs a worker on any harness that speaks the Unified Harness Protocol (UHP). PAI stays the coordinator: routing, queueing, the ledger, `follow`/`replay` and the AG2 report work as for any other worker. Only the engine differs, like `engine: "codex"`.

## Provider block

```yaml
providers:
  harness:
    engine: uhp
    baseUrl: https://harness.example.com
    keyFile: ~/.pai/keys/harness
    harnessId: claude-code        # sent as metadata.harness_id
    uhpProtocol: "1.0"            # optional pin; GET /v1/uhp is compared to it, a difference only warns
    models:
      default: sonnet
```

| Key | Meaning |
| --- | --- |
| `baseUrl` | Harness root; PAI calls `POST {baseUrl}/v1/responses`. |
| `keyFile` / `key` | Bearer token (`Authorization: Bearer ...`). |
| `harnessId` | Harness to run. Optional when every run passes `--harness`. |
| `uhpProtocol` | Pinned protocol version label. |

`pai worker config check` fails on a uhp provider with a non-http baseUrl or no key, and warns when `harnessId` is missing.

## Running

```
pai worker run --harness uhp:claude-code -p 'task'
pai worker run --provider harness -p 'task'
```

`--harness uhp:<id>` picks the enabled uhp provider pinned to that id (else the first one without a pin) and sets the harness id for the run.

## Behaviour

- The request is streamed (`stream: true`) with `Idempotency-Key` = worker id. The SSE reply is parsed strictly: `sequence_number` starts at 0 and rises by 1 with no gaps, and exactly one terminal event ends it (`response.completed|incomplete|failed`; a cancelled task ends with `response.failed` and `status: "cancelled"`, the response status is authoritative). A non-terminal `error` must be followed by a terminal event. A violation fails the run.
- Terminal status maps to the AG2 result: completed `+`, incomplete `~`, failed `-`, cancelled `!` (state killed). `error.code` (`timeout`, `cancelled`, `provider_error`, `harness_unavailable`, `model_unavailable`, `rate_limited`, `quota_exhausted`) becomes the ledger reason.
- Text deltas and function calls are written to the worker `.jsonl` in Claude-shaped lines.
- The worker status keeps the last response id and `metadata.session_id`. `pai worker resume <id> 'text'` sends `previous_response_id`.
- `pai worker kill` calls `POST {baseUrl}/v1/responses/{id}/cancel` (5 s bound, never blocks the kill) before signalling the run.
- When the harness reports another model than the requested one, the status records `requestedModel`, `modelFallback` and the reason.
- No worktree or artifact merge: files returned by the harness are listed by `download_url` in the report notes.
