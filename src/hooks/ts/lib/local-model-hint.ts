/** local-model-hint.ts — the one-line context a local-ish prompt gets. Pure. */

const LOCAL_PROMPT = /\blocal(?:ly)?\b/i; // covers "local worker", "local model", "locally"

export function isLocalPrompt(prompt: string): boolean {
  return LOCAL_PROMPT.test(prompt);
}

export function localModelHint(prompt: string, answer: string): string | null {
  if (!isLocalPrompt(prompt)) return null;
  return (
    `<system-reminder>\n${answer}. Do not probe ports or start model servers; \`--local\` picks the running model.\n</system-reminder>\n`
  );
}
