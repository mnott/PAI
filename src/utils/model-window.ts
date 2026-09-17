/**
 * model-window.ts — facts derivable from a bare model id.
 *
 * Shared by the worker stack (provider registry) and the session hooks
 * (context-fill). Zero imports on purpose: this leaf is bundled into hooks
 * (scripts/build-hooks.mjs) and must never drag config or path machinery
 * into a hook process.
 */

/** Last-resort window when nothing on hand reports one and the model id
 *  carries no window information. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Strip a bracketed variant suffix: "glm-5.3[1m]" → "glm-5.3". The suffix
 *  selects a variant of the same base model (a context-window tier, a
 *  quantization), so the prefix is the id's family. */
export function stripModelVariant(model: string): string {
  const stripped = model.replace(/\[[^\]]*\]\s*$/, "").trim();
  return stripped || model;
}

/**
 * The context window a model id itself declares, or null when the id carries
 * no window information. Only the bracketed variant suffix is read
 * ("[1m]" → 1,000,000); a bare id says nothing and stays null so callers can
 * fall back to whatever they measured themselves.
 */
export function contextWindowFromModelId(model: string | null | undefined): number | null {
  if (typeof model !== "string" || model === "") return null;
  const m = /\[(\d+)m\]$/i.exec(model.trim());
  if (!m) return null;
  const millions = Number(m[1]);
  if (!Number.isFinite(millions) || millions < 1) return null;
  return millions * 1_000_000;
}
