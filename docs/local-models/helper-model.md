# Helper model

PAI runs small side jobs on a model of their own: the route classifier, TL;DR summaries, session topic words, tool-error alerts, merge-gate summaries and report checks. Each is one short prompt with a one-word or one-sentence answer, and each has a rule-based fallback.

## Why a separate small model

On a machine with one or two big local models (say two in parallel), a side job on a big model takes a slot or forces a context swap just to classify one line. So side jobs never use a main worker model. They use a small helper model that sits next to the big ones as a third model.

## Which model

| Platform | Helper |
| --- | --- |
| macOS 26 with Apple Intelligence | `apple-fm` (Neural Engine, no extra memory; see [apple-fm.md](apple-fm.md)) |
| Anything else | A 0.6-4B instruct model (for example Qwen3 1.7B or 4B Instruct, Gemma 3 1B/4B) in Ollama, llama.cpp or MLX |

Memory: about 0.5 GB for a 0.6B model, 1-1.5 GB for 1.7B, 2.5-3 GB for a 4B model at 4-bit. Pick the smallest that answers a one-word classification correctly; `pai worker helper-check` and `helper-calls.jsonl` show whether it falls back.

## Configure

Add the small model as a provider in workers.yaml and mark it `role: helper`. Only such a provider (besides apple-fm) may serve side jobs:

```yaml
providers:
  small:
    baseUrl: http://127.0.0.1:11434
    protocol: anthropic
    role: helper
    models: { default: qwen3:1.7b }
```

Config (the PAI config file):

```json
{ "helper": {
    "models": ["apple-fm", "@helper"],
    "allowMain": false,
    "uses": { "tldr": { "models": ["ollama:qwen3:0.6b"] }, "routeClass": false }
} }
```

- `helper.models`: ordered list, first usable wins. Entries: `apple-fm`; `@helper` (every enabled local provider with `role: helper`); a provider name (accepted only with `role: helper`); `ollama:<model>` (a direct Ollama model you name). Default: `["apple-fm", "@helper"]`. When nothing is available the side job is skipped and the caller uses its rules.
- `helper.allowMain`: default `false`. A provider without `role: helper` is a main worker model and is never used for side jobs; set `true` to opt in.
- `helper.uses.<use>.models`: per-use list replacing `helper.models`. Use keys: `alert`/`toolErrors`, `tldr`, `gate`/`gateSummary`, `route`/`routeClass`, `report`/`reportCheck`, `topic`. `helper.uses.<use>: false` still switches a use off; `{ enabled: false }` works too.

## Availability

A helper that is down or times out is skipped for 60 s. A router-served helper whose slots are held by another request is skipped at once and logged as `busy-fallback`. Every attempt appends a line to `helper-calls.jsonl` (`model`, `label`, `ms`, `ok`, `kind`), so the model each call used is on record.

## Verify

```
pai worker helper-check
```

prints the helper each use resolves to, lists configured entries refused for being main models, and warns when there is none. `pai setup` prints the same warning when apple-fm is absent and no `role: helper` provider exists.
