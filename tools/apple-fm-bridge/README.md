# apple-fm-bridge

A headless localhost HTTP bridge that exposes Apple's on-device model
(FoundationModels `SystemLanguageModel` / `LanguageModelSession`, i.e. Apple
Intelligence) behind the Anthropic Messages API subset, so PAI can use it as an
opt-in local worker provider (`apple-fm`).

- Listens on **127.0.0.1:8037 only** (override with `APPLE_FM_PORT`). No GUI, no
  NSApplication — a plain command-line process.
- `GET /v1/models` → one id, `apple-fm`.
- `POST /v1/messages` → Anthropic Messages subset: `system` + `messages`
  (string or text-block content), **streaming SSE and non-streaming**.
- Tool use: tool definitions are accepted; the model is instructed to answer
  with ONE JSON object `{"tool": "<name>", "input": {...}}`, which the bridge
  turns into a proper Anthropic `tool_use` block (`stop_reason: "tool_use"`).
  This is prompt-advertised, not FoundationModels native `Tool` calling — the
  text protocol loses argument typing and needs `stream: false` (a streamed
  reply cannot be rewritten after it went out as text).
- Context guard: counts tokens with `SystemLanguageModel.tokenCount` and answers
  **400 naming the limit** when a request does not fit (context is 8192 tokens
  on this machine; read live at startup and in `GET /`).

## Build

```sh
cd tools/apple-fm-bridge
SCRATCH=${PAI_SWIFT_SCRATCH:-$HOME/.cache/pai/swift/apple-fm-bridge}  # keep .build out of the synced checkout
swift build -c release --scratch-path "$SCRATCH"   # needs macOS 27 SDK + Swift 6.4 toolchain
$(swift build -c release --scratch-path "$SCRATCH" --show-bin-path)/apple-fm-bridge
```

MIT licensed; Foundation + Network only, no dependencies.

## Use

```sh
pai models start apple-fm                 # starts the bridge on 127.0.0.1:8037
pai worker run --class simple --local apple-fm -p "..."
pai models stop apple-fm
```

The provider is opt-in: it sits in no routing tier and is used only when named.
The start command in `config.yaml` assumes a checkout at `~/dev/ai/PAI`; override
`models.runtimes.apple-fm.start` in your own config otherwise. A daemon/router
started before the provider was registered must be restarted to route `apple-fm`.

## Measured limits (M-series Mac, macOS 27.3)

- Context 8192 tokens; oversize requests get a 400 naming the limit.
- About 26 tokens/s decode, about 1.2 s to first token on a short prompt.
- Claude Code's worker prompt (system + six tool definitions + task) is about
  5.8k-6.2k tokens before any tool result, so only 2-3 turns fit. In a live run the
  model answered with a hallucinated tool call instead of the answer: usable for
  single-shot questions (no tools), not for a worker loop.
