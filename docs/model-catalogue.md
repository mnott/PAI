# Listing models

PAI keeps no catalogue of vendor models: ids, context sizes and prices change faster than a document can follow. Ask the tools, and check the vendor's own pricing page for money.

| Question | Command |
|---|---|
| Which models does each provider have configured (default, fast, image, ...)? | `pai worker model` |
| What does one capability resolve to? | `pai worker model fast`, `pai worker capability` |
| Providers: state, models, caps, tiers | `pai worker providers` |
| Which model serves each tier right now? | `pai worker route` |
| What runs on this machine (Strata, vllm-mlx, llama-server, ollama, Docker Model Runner), with memory, port and who uses it? | `pai models` (`--fresh` probes now, `--json` for scripts) |
| Which local model is up, which can I start? | `pai worker local status`, `pai worker local` |
| What did runs actually cost, per provider and model? | `pai worker usage --since 2h` |

Change a provider's model with `pai worker model MODEL-ID` (active provider's default) or `pai worker model CAPABILITY MODEL-ID`; change what a tier uses with `pai worker route set` ([workers-config.md](workers-config.md#changing-the-model-hierarchy)). Adding a provider with its model ids: [providers](concepts/providers.md#adding-a-provider-worked-example). Local models: [local models](concepts/local-models.md).

The earlier dated catalogue of vendor models and prices (2026-09-20) was removed: it predated the open capability set, the image engine and the tier table, and was not generated.
