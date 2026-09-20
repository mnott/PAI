# Model catalogue for PAI providers (2026-09-20)

Every row below was checked against the provider's own docs/pricing page via
WebFetch, or — where the official page didn't render a usable table for the
fetch summarizer, or officially wasn't reachable — against a WebSearch
synthesis of third-party trackers, marked "3rd-party" in the Source column.
Anything neither source confirmed is UNKNOWN. Prices are list/pay-as-you-go,
USD, as of today; providers change these often — re-check before relying on
a number for billing.

Context on what PAI can run today (verified in this worktree, not assumed):

- `WorkerProtocol` is `"anthropic" | "openai"` (`src/workers/config.ts:37`).
  `"openai"` runs through PAI's local proxy (`src/workers/proxy/`), which
  translates Anthropic Messages ⇄ OpenAI Chat Completions — **not** the
  Responses API.
- `MODEL_CAPABILITIES` is the closed set `["default", "fast", "image"]`
  (`src/workers/config.ts:261`). There is **no** open-set `models: {…,
  vision, longcontext, reasoning}` and **no** top-level `capabilities:`
  preference map in this codebase today — the spec's mention of both is
  forward-looking (a parallel worker's WIP), not current state. The nearest
  existing equivalents are `tags:` (`code, vision, image-gen, long-context,
  fast, reasoning` — routing filters, not model ids) and `classes.<name>` /
  `classes.<name>.requireTags`.
- There is **no `image` engine**. `WorkerEngine` is `"claude" | "codex"`
  only (`src/workers/config.ts:40`). A provider's `models.image` id is real
  config (`glm.models.image: example-paint` is already set in the live
  `workers.yaml`) but nothing in `run.ts` treats it specially: the "image"
  class just launches Claude Code or Codex with `--model <that id>` over the
  normal chat protocol. **No code path calls an images-generation endpoint**
  (`POST {url}/images/generations` or equivalent). Until that engine lands,
  none of the image-generation APIs in §1.11 are reachable through
  `pai worker run` — see §2 and §5.

## 1. Provider families

### 1.1 Anthropic

Source: https://platform.claude.com/docs/en/models/overview (redirects from
docs.anthropic.com; fetched verbatim).

| Model id | For | Context | Max output | Input / Output per 1M | Protocol | Base URL | Notes |
|---|---|---|---|---|---|---|---|
| `claude-fable-5-1` | reasoning, longcontext | 1M | 128K | $10 / $50 | anthropic | api.anthropic.com | Adaptive thinking always on; knowledge cutoff Jun 2026 |
| `claude-opus-5` | default (complex) | 1M | 128K | $5 / $25 | anthropic | api.anthropic.com | |
| `claude-sonnet-5` | default | 1M | 128K | $2 / $10 | anthropic | api.anthropic.com | PAI's `NATIVE_ANTHROPIC_MODELS.default` |
| `claude-haiku-4-5-20251001` | fast | 200K | 64K | $1 / $5 | anthropic | api.anthropic.com | PAI's `NATIVE_ANTHROPIC_MODELS.fast`; vision on all four |

All four: text+image input, vision, tool use, native to PAI's `protocol:
"anthropic"` — no proxy, no translation, this is what `ANTHROPIC_NATIVE`
already runs on.

### 1.2 OpenAI

Sources: https://developers.openai.com/api/docs/models (redirects from
platform.openai.com/docs/models; WebFetch, some entries cross-checked by
WebSearch since the fetch summarizer produced a couple of clearly-fabricated
codenames on the first pass — see caveat below) and
https://developers.openai.com/api/docs/models/gpt-6-astra (fetched directly,
verbatim numbers).

| Model id | For | Context | Max output | Input / Output per 1M | Protocol | Base URL | Notes |
|---|---|---|---|---|---|---|---|
| `gpt-6-astra` | default (flagship) | 1.05M | 128K | $10 / $50 | openai-chat *(Chat Completions listed "Supported") / openai-responses for tool calling* | api.openai.com/v1 | Tool calling requires the Responses API per OpenAI's own migration guide — a plain chat run works over Chat Completions, but PAI workers that use tools would lose them through the proxy today |
| `gpt-5.1` | default (legacy) | 400K | 128K | UNKNOWN (legacy pricing page not fetched) | openai-chat | api.openai.com/v1 | Still listed, "previous flagship" |
| `gpt-5-mini` | fast | 272K–400K (sources disagree) | 128K | $0.25 / $2.00 | openai-chat | api.openai.com/v1 | 3rd-party cross-check |
| `gpt-5-nano` | fast | 272K–400K (sources disagree) | 128K | $0.05 / $0.40 | openai-chat | api.openai.com/v1 | 3rd-party cross-check |
| `gpt-image-2` (snapshot `gpt-image-2-2026-04-21`) | image | n/a | n/a | ~$0.006 / $0.053 / $0.211 per 1024×1024 image at low/med/high quality (metered as output image tokens, not a flat per-image price) | images-api | api.openai.com/v1/images/generations | 3rd-party; current flagship image model, replaces `gpt-image-1.5` |
| `gpt-image-1-mini` | image | n/a | n/a | ~$0.005 / $0.011 / $0.036 per image (low/med/high, 1024×1024) | images-api | api.openai.com/v1/images/generations | 3rd-party |

**Caveat on this table:** the first WebFetch against `developers.openai.com/api/docs/models`
returned model ids (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
`gpt-daybreak-red-latest`, `gpt-daybreak-blue-latest`) that could not be
corroborated by a follow-up WebSearch and read as fabricated by the
page-summarizing model — they are **not** included above. `gpt-6-astra` and
the GPT-5.x ids *were* corroborated independently (direct fetch of its own
model page, plus multiple WebSearch hits referencing it as "the current
flagship" and giving matching numbers), so those are kept. Treat any OpenAI
model id not in the table above, that you see in a single search result, as
unverified until you load its own `/docs/models/<id>` page directly.

### 1.3 Google Gemini

Sources: https://ai.google.dev/gemini-api/docs/models (WebFetch),
https://ai.google.dev/gemini-api/docs/pricing (WebFetch, verbatim numbers),
WebSearch cross-check against ai.google.dev/gemini-api/docs/gemini-3 and
OpenRouter listings.

| Model id | For | Context | Vision | Input / Output per 1M | Protocol | Base URL | Notes |
|---|---|---|---|---|---|---|---|
| `gemini-3-pro-preview` | default | 1,048,576 | yes | UNKNOWN (deprecated, shut down 2026-03-09) | openai-chat *(via compat layer)* or native REST | generativelanguage.googleapis.com | Superseded by `gemini-3.1-pro-preview` |
| `gemini-3.5-flash` | default/fast | 1,048,576 | yes | $1.50 / $9.00 | openai-chat or native REST | generativelanguage.googleapis.com | |
| `gemini-3.5-flash-lite` | fast | 1,048,576 | yes | $0.30 / $2.50 | openai-chat or native REST | generativelanguage.googleapis.com | text/image/video/audio input |
| `gemini-3.8-flash` | default/fast | UNKNOWN | yes | $0.75 / $3.75 (promo through 2026-12-31, then $1.50/$7.50) | openai-chat or native REST | generativelanguage.googleapis.com | Latest in the 3.x Flash line per docs |
| `gemini-3.1-flash-image` ("Nano Banana 2") | image | UNKNOWN | yes (image in/out) | $0.50/1M input; image output ≈$0.045/0.5K-px image, $0.067/1K-px image | images-api-ish *(REST `generateContent`, not OpenAI images schema)* | generativelanguage.googleapis.com | Real Google-used nickname; verified by 2 independent WebSearch results |
| `gemini-3.1-flash-lite-image` ("Nano Banana 2 Lite") | image | UNKNOWN | yes | $0.25/1M input; ≈$0.0336/1K-px image output | images-api-ish | generativelanguage.googleapis.com | |

Google publishes an OpenAI-compatibility shim
(`https://generativelanguage.googleapis.com/v1beta/openai/`) documented on
the same models page, which is why the Chat-family entries above list
`openai-chat` as usable — PAI's proxy targets exactly that shape.

### 1.4 xAI (Grok)

Source: https://docs.x.ai/docs/models (WebFetch; ids like
`grok-4.20-0309-reasoning` look unusual but xAI does use dated build
suffixes — not independently cross-checked, flagged accordingly).

| Model id | For | Context | Input / Output per 1M | Protocol | Base URL | Notes |
|---|---|---|---|---|---|---|
| `grok-4.6` | default | 500K | $2.00–4.00 / $6.00–12.00 (tiered past 200K prompt) | openai-chat | api.x.ai/v1 | Docs recommend this as default |
| `grok-4.3` | longcontext | 1M | $1.25–2.50 / $2.50–5.00 | openai-chat | api.x.ai/v1 | UNVERIFIED beyond single fetch |
| `grok-build-0.1` | fast/coding | 256K | $1.00–2.00 / $2.00–4.00 | openai-chat | api.x.ai/v1 | UNVERIFIED beyond single fetch |
| `grok-imagine-image-2.0` | image | n/a | $0.04/image | images-api (xAI-specific schema, not OpenAI images) | api.x.ai/v1 | UNVERIFIED beyond single fetch |

xAI's API is documented as OpenAI-Chat-Completions-shaped for the text
models (this is well-established from xAI's long-standing SDK compat, not
just this fetch).

### 1.5 Mistral

Sources: https://docs.mistral.ai/getting-started/models/models_overview/,
https://mistral.ai/pricing, https://mistral.ai/pricing/api — none of the
three rendered a full table for the fetch tool; numbers below are the
fragments the fetches did surface, explicitly marked incomplete.

| Model id | For | Context | Input / Output per 1M | Protocol | Base URL | Notes |
|---|---|---|---|---|---|---|
| `mistral-large-latest` (Large 3) | default | UNKNOWN | $0.5 / $1.5 | openai-chat | api.mistral.ai/v1 | Exact API id string not confirmed — page named the model "Mistral Large 3", not its API slug |
| `mistral-medium-latest` (Medium 3.5) | default | UNKNOWN | $1.5 / $7.5 | openai-chat | api.mistral.ai/v1 | Same caveat |
| `mistral-small-latest` (Small 4) | fast | UNKNOWN | $0.15 / $0.6 | openai-chat | api.mistral.ai/v1 | Same caveat |
| `codestral-latest` | coding | UNKNOWN | $0.3 / $0.9 | openai-chat | api.mistral.ai/v1 | Same caveat |
| `ministral-3b-latest` / `ministral-8b-latest` | fast | UNKNOWN | $0.1/$0.1, $0.15/$0.15 | openai-chat | api.mistral.ai/v1 | Same caveat |

Mistral's La Plateforme API id strings could not be confirmed from the pages
fetched (they showed marketing names, not `models/list`-style ids); before
using any of these, hit `GET https://api.mistral.ai/v1/models` to get exact
ids. Everything else (pricing, context) is UNKNOWN or from the fragment
above — do not treat this row group as fully verified.

### 1.6 DeepSeek

Source: https://api-docs.deepseek.com/quick_start/pricing (WebFetch,
verbatim).

| Model id | For | Context | Max output | Input / Output per 1M | Vision | Protocol | Base URL |
|---|---|---|---|---|---|---|---|
| `deepseek-flash` | default/fast | 1M | 384K | $0.15 / $0.60 (off-peak; peak hours 01:00–04:00 & 06:00–10:00 UTC Mon–Fri double the rate) | yes | openai-chat | api.deepseek.com |
| `deepseek-v4-pro` | default (reasoning) | 1M | 384K | $0.66 / $1.98 (off-peak) | no | openai-chat | api.deepseek.com |

Docs explicitly say both accept "OpenAI Format" requests — this is a clean
`protocol: openai` target for PAI's proxy.

### 1.7 Zhipu / Z.ai (GLM)

Sources: https://docs.z.ai/api-reference/llm/chat-completion (WebFetch)
cross-checked by WebSearch against OpenRouter/Requesty/Together listings.
The live `workers.yaml` in this environment already configures `glm` (real
key present — not reproduced here) against Z.ai's **Anthropic-compatible**
endpoint, confirming the second protocol row is real, not just documented.

| Model id | For | Context | Max output | Input / Output per 1M | Protocol | Base URL |
|---|---|---|---|---|---|---|
| `glm-5.3` | default | 1,048,576 | 128K | $1.40 / $4.40 ($0.26 cached input) | anthropic **or** openai-chat | `https://api.z.ai/api/anthropic` (anthropic) or `https://api.z.ai/api/paas/v4` (openai-chat, `POST /chat/completions`) |
| `glm-5.3-flash` | fast | UNKNOWN | 128K | UNKNOWN | anthropic or openai-chat | same |
| `glm-5.2` | default (prior) | 1,048,576 | 131,072 | ~$0.49–1.56 depending on host (Z.ai direct cheapest) | anthropic or openai-chat | same |
| `glm-4.6v` / `glm-4.5v` | vision | UNKNOWN | UNKNOWN | UNKNOWN | anthropic or openai-chat | same |

This is the one family already proven end-to-end: 284 of 495 recorded
worker runs in this environment's ledger used `provider: glm` — see §5.

### 1.8 Moonshot (Kimi)

Sources: https://platform.moonshot.ai/docs/pricing → redirects to
https://platform.kimi.ai/docs/pricing (WebFetch). The live `workers.yaml`
configures `kimi` against `https://api.kimi.ai/coding/` (an
Anthropic-compatible endpoint distinct from the general Moonshot platform
API below — confirmed by the live config using `protocol: anthropic`
implicitly, i.e. no `protocol:`/`upstream_url` set for it).

| Model id | For | Context | Input / Output per 1M | Protocol | Base URL |
|---|---|---|---|---|---|
| `kimi-k3` | default | 1,048,576 | $3.00 / $15.00 ($0.30 cached input) | anthropic (coding endpoint) or openai-chat (general platform) | `https://api.kimi.ai/coding/` (anthropic) or `https://api.moonshot.ai/v1` (openai-chat) |
| `kimi-k2.7-code` | default (cheaper) | 262,144 | $0.95 / $4.00 | openai-chat | api.moonshot.ai/v1 |
| `kimi-k2.7-code-highspeed` | fast | 262,144 | $1.90 / $8.00 | openai-chat | api.moonshot.ai/v1 |
| `kimi-k2.6` | default (older) | 262,144 | $0.95 / $4.00 | openai-chat | api.moonshot.ai/v1 |

12 of 495 recorded runs in this environment used `provider: kimi` — see §5.
The fetched doc didn't state explicitly which of the two base URLs is
OpenAI- vs Anthropic-shaped; the live config's usage (no `protocol:` field
= defaults to `"anthropic"`) is the confirmation for the coding endpoint.

### 1.9 Alibaba Qwen (DashScope / Model Studio)

Source: WebSearch synthesis (official docs page
https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-dashscope
was found but not directly fetched — 3rd-party pricing trackers used for
numbers).

| Model id | For | Context | Input / Output per 1M | Protocol | Base URL | Notes |
|---|---|---|---|---|---|---|
| `qwen3.8-max` | default (flagship) | 1M | $2.00 / $6.00 ($0.25 cached) | anthropic, openai-chat, or DashScope-native (all three documented) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (openai-chat) | GA 2026-08-03; multi-region (Beijing/Singapore/Tokyo/Frankfurt/Virginia) |
| `qwen3-max` | default (prior) | 262K | $0.78–3.00 (tiered) / up to $3.90 | same three | same | |
| `qwen3.5-plus` | default (mid) | 256K (rate doubles above) | $0.40 / $2.40 | same | same | |
| `qwen3.5-flash` | fast | UNKNOWN | $0.10 / $0.40 | same | same | |

The "OpenAI-, Anthropic-, and DashScope-compatible endpoints" claim came up
independently in the WebSearch synthesis for `qwen3.8-max`; if accurate,
Qwen could run with `protocol: anthropic` (no proxy) exactly like GLM/Kimi —
worth confirming with one live `curl` before configuring it that way, since
it wasn't checked against the primary doc page directly.

### 1.10 Meta Llama via hosted APIs

Sources: https://console.groq.com/docs/models (WebFetch, verbatim ids),
WebSearch synthesis for Together AI / Fireworks AI (official model-list
pages didn't render Llama ids for the fetch tool; numbers are 3rd-party).

| Model id | Host | Context | Input / Output per 1M | Protocol | Base URL | Notes |
|---|---|---|---|---|---|---|
| `llama-3.1-8b-instant` | Groq | 131,072 | UNKNOWN (moved to enterprise-only per one 3rd-party source, unconfirmed) | openai-chat | api.groq.com/openai/v1 | |
| `llama-3.3-70b-versatile` | Groq | 131,072 | UNKNOWN (same caveat) | openai-chat | api.groq.com/openai/v1 | |
| `openai/gpt-oss-120b` | Groq | 131,072 | $0.15 / $0.60 (3rd-party) | openai-chat | api.groq.com/openai/v1 | Not a Llama model, but Groq's current cheap/fast default per one source |
| `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Together AI | UNKNOWN | ~$1.04/$1.04 (3rd-party, rising from ~$0.88 mid-2026) | openai-chat | api.together.xyz/v1 | Exact id not directly confirmed on together.ai/models fetch — verify via their `/models` list endpoint |
| Llama 3.1 70B–class | Fireworks AI | UNKNOWN | ~$0.90/$0.90 flat for >16B models (3rd-party) | openai-chat | api.fireworks.ai/inference/v1 | Exact id not confirmed |

All three (Groq, Together, Fireworks) are documented OpenAI-Chat-Completions
compatible — this family is the cleanest `protocol: openai` fit once ids are
confirmed against each provider's `/v1/models` endpoint.

### 1.11 Image-generation APIs

| Provider | Model id | Price | API shape | Base URL | Source |
|---|---|---|---|---|---|
| OpenAI | `gpt-image-2` | see §1.2 | `POST /v1/images/generations` (OpenAI images schema) | api.openai.com | WebSearch, multiple corroborating |
| Google | `gemini-3.1-flash-image` | see §1.3 | `POST /v1beta/models/{model}:generateContent` (Gemini schema, image parts in/out — **not** the OpenAI images schema) | generativelanguage.googleapis.com | WebFetch pricing page |
| Black Forest Labs | `flux-2-pro`, `flux-2-klein-4b`, `flux-2-klein-9b`, `flux-2-flex`, `flux-2-max` | $0.014–$0.07/megapixel, credit-based (1 credit = $0.01) | BFL-specific REST, async job polling | api.bfl.ai | WebSearch (docs.bfl.ml, bfl.ai/pricing) |
| Stability AI | Stable Image Ultra / Core / SD3.5 (Medium/Large/Flash/Large-Turbo) | $0.025–$0.08/image, credit-based (1 credit = $0.01) | Stability REST (`POST /v2beta/stable-image/generate/...`) | api.stability.ai | WebSearch (official pricing page returned only a title to the fetch tool) |
| Ideogram | `ideogram-4.0`, `ideogram-3.0`, `ideogram-p-image` | $0.02–$0.10/image by version/quality tier | Ideogram REST | api.ideogram.ai | WebSearch |
| Recraft | Recraft V3 / V4 (Styles Pro, Styles Vector) | $0.04 raster / $0.08 vector / $0.10–$0.055 for style variants | Recraft REST, API-unit billed | external.api.recraft.ai | WebSearch |
| Replicate (gateway) | e.g. `black-forest-labs/flux-1.1-pro`, `ideogram-ai/ideogram-v3-quality` | pass-through per-model, e.g. $0.04 and $0.09/image respectively | Replicate REST (`POST /v1/predictions`), async | api.replicate.com | WebFetch (replicate.com/pricing) |

None of these speak the OpenAI Chat Completions or Messages protocol —
they're all their own REST job/response shapes (some sync, some async
job-polling). PAI's proxy translates Anthropic↔OpenAI-chat; it does not
translate to any of these images schemas, and there is no `engine: image`
runner today (see the note at the top of this document and §2/§5).

## 2. What PAI can use today, with a small change, or not at all

**Usable today, unchanged** (`protocol: anthropic`, no proxy, no engine
work):
- Anthropic (native, already the default)
- Z.ai GLM via `https://api.z.ai/api/anthropic` — proven live (§1.7, §5)
- Moonshot Kimi via `https://api.kimi.ai/coding/` — proven live (§1.8, §5)
- Alibaba Qwen, *if* its Anthropic-compatible endpoint holds up under a real
  `curl` test (claimed in 3rd-party sources, not confirmed against Alibaba's
  own doc page — do one `pai worker providers test` before trusting it)

**Usable today through `protocol: openai` (the existing proxy), unchanged**,
provided the provider's tool-calling still works over Chat Completions
(untested end-to-end — see §5):
- DeepSeek (`api.deepseek.com`, docs say "OpenAI Format" explicitly)
- Z.ai GLM's OpenAI-compatible endpoint (`/api/paas/v4`) as an alternative
  to the Anthropic one
- Moonshot's general platform endpoint (`api.moonshot.ai/v1`)
- xAI Grok (`api.x.ai/v1`)
- Groq, Together AI, Fireworks AI (Llama and others)
- OpenAI itself, for models that don't require the Responses API for tool
  calls (`gpt-5.1`, `gpt-5-mini`, `gpt-5-nano`); `gpt-6-astra` would lose
  tool-calling through Chat Completions per OpenAI's own docs
- Google Gemini via its documented OpenAI-compatibility shim
  (`.../v1beta/openai/`)
- Mistral, once exact model ids are confirmed via `GET /v1/models`

**Needs a small change:**
- **Codex CLI providers** (`engine: codex`) already exist as a config
  option (`WorkerEngine`, `src/workers/config.ts:40`) — no OpenAI-Responses
  work needed for a ChatGPT-plan provider, just `pai worker providers add
  <name> --engine codex`.
- **OpenAI Responses-only models** (`gpt-6-astra` with tools, and any future
  model that drops Chat Completions tool support) need the proxy's
  translator (`src/workers/proxy/translate.ts`) extended to speak Responses
  as well as Chat Completions — real work, not config.

**Cannot be used at all today:**
- Every image-generation API in §1.11 (OpenAI images, Google Imagen/Nano
  Banana, Flux, Stability, Ideogram, Recraft, Replicate) — none speak
  Anthropic Messages or OpenAI Chat Completions, and no `engine: image` (or
  equivalent images-job runner) exists in this codebase to call them. A
  provider's `models.image` field is accepted by config validation today,
  but nothing consumes it as an image request — it's just the id `run.ts`
  passes to `--model` on a normal chat run, which will simply fail (or
  silently run as a chat model, if the id also happens to answer chat) on
  a real image-only endpoint.

## 3. `workers.yaml` snippets

All of these are commented out and use placeholder key files under
`~/.claude/pai/keys/<name>` (the on-disk field is `key_file`; `keysDir()` in
`src/workers/config.ts:1050` resolves to `paiHomePath("keys")`, i.e.
`~/.claude/pai/keys`). Every snippet below was validated to parse without
throwing via `readWorkersYaml()` against a temp file — see §3 validation
output. None of this was written into the live `~/.claude/pai/workers.yaml`.

```yaml
# --- OpenAI, via the PAI proxy (protocol: openai) ---
# providers:
#   openai:
#     protocol: openai
#     upstream_url: "https://api.openai.com/v1"
#     key_file: "~/.claude/pai/keys/openai"
#     models:
#       default: gpt-5.1        # gpt-6-astra needs Responses API for tools — see docs/model-catalogue.md §2
#       fast: gpt-5-mini
#     tier: 4

# --- Google Gemini, via its OpenAI-compatibility shim ---
# providers:
#   gemini:
#     protocol: openai
#     upstream_url: "https://generativelanguage.googleapis.com/v1beta/openai"
#     key_file: "~/.claude/pai/keys/gemini"
#     models:
#       default: gemini-3.5-flash
#       fast: gemini-3.5-flash-lite
#     tags: [vision, long-context]
#     tier: 2

# --- xAI Grok ---
# providers:
#   xai:
#     protocol: openai
#     upstream_url: "https://api.x.ai/v1"
#     key_file: "~/.claude/pai/keys/xai"
#     models:
#       default: grok-4.6
#       fast: grok-build-0.1
#     tier: 3

# --- Mistral (confirm exact model ids via GET /v1/models before use) ---
# providers:
#   mistral:
#     protocol: openai
#     upstream_url: "https://api.mistral.ai/v1"
#     key_file: "~/.claude/pai/keys/mistral"
#     models:
#       default: mistral-large-latest
#       fast: mistral-small-latest
#     tier: 2

# --- DeepSeek ---
# providers:
#   deepseek:
#     protocol: openai
#     upstream_url: "https://api.deepseek.com"
#     key_file: "~/.claude/pai/keys/deepseek"
#     models:
#       default: deepseek-v4-pro
#       fast: deepseek-flash
#     tier: 1

# --- Zhipu / Z.ai GLM (native anthropic — same shape as the live glm provider) ---
# providers:
#   glm2:
#     url: "https://api.z.ai/api/anthropic"
#     key_file: "~/.claude/pai/keys/glm2"
#     models:
#       default: glm-5.3
#       fast: glm-5.3-flash
#     tier: 2

# --- Moonshot Kimi (native anthropic, coding endpoint — same shape as the live kimi provider) ---
# providers:
#   kimi2:
#     url: "https://api.kimi.ai/coding/"
#     key_file: "~/.claude/pai/keys/kimi2"
#     models:
#       default: kimi-k3
#     tier: 3

# --- Alibaba Qwen (verify anthropic-compatible endpoint before relying on this) ---
# providers:
#   qwen:
#     protocol: openai
#     upstream_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
#     key_file: "~/.claude/pai/keys/qwen"
#     models:
#       default: qwen3.8-max
#       fast: qwen3.5-flash
#     tier: 3

# --- Meta Llama via Groq ---
# providers:
#   groq:
#     protocol: openai
#     upstream_url: "https://api.groq.com/openai/v1"
#     key_file: "~/.claude/pai/keys/groq"
#     models:
#       default: openai/gpt-oss-120b
#       fast: llama-3.1-8b-instant
#     tier: 1

# --- Preference example: today's mechanism (classes, not a capabilities: map) ---
# No top-level `capabilities:` block exists yet (see docs/model-catalogue.md).
# The current equivalent of "prefer an image provider for image, Claude for
# everything else" is per-class routing:
# classes:
#   image: glm2/image     # once an image engine exists — see §2, §5
#   implement: anthropic
#   draft: anthropic
```

### Validation

Ran a temp vitest (`src/workers/model-catalogue-snippets.test.ts`, added on
this branch) that writes each uncommented provider block above into an
isolated `workers.yaml` (via `PAI_WORKERS_YAML`) and calls
`readWorkersYaml()` from `src/workers/workers-config.ts`, asserting it does
not throw and that `data.providers.<name>.protocol` /
`.upstreamUrl` match what's intended. Output:

```
$ bunx vitest run src/workers/model-catalogue-snippets.test.ts

 RUN  v4.0.18 <worktree>

 ✓ src/workers/model-catalogue-snippets.test.ts (9 tests) 11ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  18:49:03
   Duration  208ms (transform 83ms, setup 21ms, import 96ms, tests 11ms, environment 0ms)
```

All 9 snippets (`openai`, `gemini`, `xai`, `mistral`, `deepseek`, `glm2`,
`kimi2`, `qwen`, `groq`) parsed without a `WorkersConfigError` and reported
the expected `protocol`/`upstream_url`. Re-run with the command above to
reproduce (run `bun install` first if `node_modules` is missing).

## 4. How to add one (today's real CLI, verified against `--help`)

```
# 1. Save the key
mkdir -p ~/.claude/pai/keys && chmod 700 ~/.claude/pai/keys
printf '%s' 'sk-...' > ~/.claude/pai/keys/deepseek && chmod 600 ~/.claude/pai/keys/deepseek

# 2. Add the provider (flags confirmed via `pai worker providers add --help`)
pai worker providers add deepseek \
  --protocol openai --upstream-url https://api.deepseek.com \
  --key-file ~/.claude/pai/keys/deepseek \
  --model deepseek-v4-pro --fast-model deepseek-flash \
  --cost-tier 1

# 3. Set the model per capability (no `pai worker model image ...` shorthand
#    beyond what `model` already does — capabilities are default/fast/image)
pai worker model image example-paint --provider deepseek   # only meaningful once an image engine exists — see §2

# 4. Point a class at it (there is no `pai worker capability image <name>` —
#    that command doesn't exist; classes are the current mechanism)
#    Edit workers.yaml: classes.image: deepseek/image
#    or: pai worker classes   # to see current routing, then edit by hand

# 5. Run against it
pai worker run --provider deepseek -p "…" --allowedTools 'Read,Edit,Bash'
# or, once a class points at it:
pai worker run --class image -p "…"
```

`pai worker model` and `pai worker classes` are real (`pai worker model
--help`, `pai worker --help`); `pai worker capability` is **not** a command
in this codebase — the task's suggested walkthrough
(`pai worker capability image <name>`) doesn't exist yet, so step 4 above
uses what does.

## 5. State of the OpenAI-protocol path

Fact, not assumption, gathered from this environment's own ledger and test
suite:

- **495 recorded worker runs** in `~/.claude/pai/logs/workers/*.status`
  (this machine's ledger) break down as `anthropic`: 199, `glm`: 284,
  `kimi`: 12. **Zero** used a provider with `protocol: "openai"` — `glm` and
  `kimi` are both configured in the live `workers.yaml` against
  Anthropic-compatible endpoints (`api.z.ai/api/anthropic`,
  `api.kimi.ai/coding/`), not through the proxy.
- `src/workers/proxy/server.test.ts` and `translate.test.ts` (36 test cases
  total) exercise the Anthropic↔OpenAI translation and the proxy's HTTP
  server exclusively against an in-process mock upstream
  (`server.test.ts:96` "non-streaming: translates both directions ... passes
  the keyFile token upstream" spins up a local fake server, not a real
  OpenAI-compatible API).
- No file under `docs/`, no CHANGELOG entry, and no `.status`/`.jsonl`
  ledger line names a provider with `upstream_url` set that actually ran.

**Conclusion:** the `protocol: openai` proxy path is implemented and unit-
tested against synthetic upstreams, but as of 2026-09-20 no worker run in
this environment's history has completed through it against a real
OpenAI-Chat-Completions provider. The first live use of any provider in
§1.2–§1.6, §1.9, §1.10 above (all `openai-chat` protocol) would be this
codebase's first real exercise of that path — worth a `pai worker providers
test <name>` smoke run before depending on it for real work.
