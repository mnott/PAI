/** Scripted summarizer: each call pops the next scripted text in the real summary format. */
export class FakeSummarizer {
  queue: string[] = [];
  prompts: string[] = [];
  calls = 0;
  /** Used when the queue is empty (stress runs). */
  fallback: ((prompt: string) => string) | null = null;

  push(...texts: string[]): this { this.queue.push(...texts); return this; }
  reset(): void { this.queue = []; this.prompts = []; this.calls = 0; this.fallback = null; }

  fn = async (prompt: string): Promise<string | null> => {
    this.calls++;
    this.prompts.push(prompt);
    const next = this.queue.shift();
    if (next !== undefined) return next;
    return this.fallback ? this.fallback(prompt) : null;
  };
}

/** A summary in the format the summarizer prompt asks for. */
export function summaryText(topic: string, title: string, work: string[], extra = ""): string {
  return `TOPIC: ${topic}

# Session: ${title}

**Date:** 2026-11-26
**Status:** In Progress

---

## Work Done

${work.map((w) => `- ${w}`).join("\n")}
${extra}
`;
}
