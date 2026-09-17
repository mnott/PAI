# Provider Independence

> My AI budget hit 91% before lunch. So I changed one rule: the expensive
> assistant keeps the thinking, a cheaper crew does the building. The feature
> shipped anyway.
>
> Your AI bill is not a fact of nature. It is a design decision.

Your assistant runs its helper crew on whichever AI provider you choose —
and so can the session itself.

## Switching

- **The crew.** Once, at the start: "Add a worker provider named glm — here
  is the key." Then: "Use glm for the workers from now on."
- **The session itself.** Start it with the `glm` command — the shim for
  `pai worker run` — or just pick a project with `pai`: the picker follows
  the active provider too, so the whole session, you included, runs on it.

Swapping back — or to any other provider — is one sentence for the crew, and
starting `claude` again for the session.

## A day with the crew

- "Fix the login timeout bug." — a worker named *fix login timeout* starts; the status line shows its name and current step, live.
- "What are my workers doing?" — a short list, by name.
- "Tell fix login timeout to also check the retry path." — lands mid-run; the worker adapts.
- "Show me what it changed." — the diff comes back for your review.
- "Stop using workers for now." — the crew stands down.

![The worker row live in the status line.](images/workers.png)

## Further

- [How it works — full tool reference](provider-independence-details.md)
- [The provider layer, in depth](provider-abstraction.md)
