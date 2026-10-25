# UHP engine

A provider with `engine: "uhp"` runs a worker on any harness that speaks the Unified Harness Protocol (UHP). PAI stays the coordinator: routing, queueing, the ledger, `follow`/`replay` and the AG2 report work as for any other worker. Only the engine differs, like `engine: "codex"`.

## Provider block

```yaml
providers:
  harness:
    engine: uhp
    baseUrl: https://harness.example.com
    keyFile: ~/.pai/keys/harness
    harnessId: chrn_0123abcd      # the server's harness id (not a base such as claude-code); sent as metadata.harness_id
    uhpProtocol: "2026-10-19"     # optional pin, sent as UHP-Version; must be a date
    models:
      default: sonnet
```

| Key | Meaning |
| --- | --- |
| `baseUrl` | Harness root; PAI calls `POST {baseUrl}/v1/responses`. |
| `keyFile` / `key` | Bearer token (`Authorization: Bearer ...`). |
| `harnessId` | Harness to run. Optional when every run passes `--harness`. |
| `uhpProtocol` | Pinned protocol version (`YYYY-MM-DD`), sent as the `UHP-Version` request header. `pai worker config check` rejects other shapes. A server that does not support it answers `400 unsupported_protocol_version` with `detail.supported`, which PAI prints. The version the server answered with (response `UHP-Version`) is recorded in the status as `uhpVersion`. |

`pai worker config check` fails on a uhp provider with a non-http baseUrl or no key, and warns when `harnessId` is missing.

## Discovery

`GET {baseUrl}/v1/uhp` needs no key and returns `{object, protocol: "uhp", versions[], default_version, conformance_class, capabilities{...}}`. PAI requires `protocol: "uhp"` and reads `default_version`, `versions`, `conformance_class` and `capabilities` (absent capability = false). With a pin set, a pin missing from `versions` logs a warning before the run.

## Running

```
pai worker run --harness uhp:chrn_0123abcd -p 'task'
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
