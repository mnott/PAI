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
swift build -c release          # needs macOS 27 SDK + Swift 6.4 toolchain
.build/out/Products/Release/apple-fm-bridge   # or .build/release/apple-fm-bridge
```

MIT licensed; Foundation + Network only, no dependencies.
