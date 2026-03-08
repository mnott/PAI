/**
 * Auto-name extraction and string helpers for session-cleanup.
 * Derives a meaningful session title from Markdown content.
 */

// Meta-phrases indicating template/status text rather than real work.
const META_PHRASE_PATTERNS: RegExp[] = [
  /session initialized and ready for your instructions/i,
  /fresh session with no pending tasks/i,
  /starting new session.*checking for pending work/i,
  /fresh session with empty todo/i,
  /session started and ready/i,
  /^session\b.*\bready\b/i,
  /^session\b.*\binitialized\b/i,
  /^session\b.*\bno pending\b/i,
  /^session\b.*\bno prior work\b/i,
  /^no pending tasks/i,
  /^no prior work/i,
];

const TITLE_CASE_MINOR_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "for", "to", "of", "and", "or",
  "but", "via", "with", "from", "by", "as", "nor",
]);

function cleanMarkdownLine(raw: string): string | null {
  let s = raw.trim();
  s = s.replace(/^[-*+]\s+\[[ xX]\]\s*/, "");
  s = s.replace(/^[-*+]\s+/, "");
  s = s.replace(/^\[[ xX]\]\s*/, "");
  s = s.replace(/\*\*\s*([^*]+?)\s*\*\*/g, "$1");
  s = s.replace(/\*\s*([^*]+?)\s*\*/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/^\*+\s*/, "");
  s = s.replace(/^[.,;:]+/, "").replace(/[.,;:]+$/, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.length >= 4 ? s : null;
}

function isMetaPhrase(text: string): boolean {
  return META_PHRASE_PATTERNS.some((re) => re.test(text));
}

function toTitleCase(text: string): string {
  const words = text.split(" ");
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i !== 0 && TITLE_CASE_MINOR_WORDS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

export function sanitizeName(raw: string): string {
  let s = raw.replace(/[\/\\:*?"<>|#`]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 60) {
    const truncated = s.slice(0, 60);
    const lastSpace = truncated.lastIndexOf(" ");
    s = lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
  }
  s = s.trim();
  return toTitleCase(s);
}

export function extractAutoName(content: string): string {
  const lines = content.split("\n");

  const CONTENT_SECTION_HEADINGS = new Set([
    "Work Done", "Summary", "Completed", "What Was Done",
    "Results", "Outcomes", "Changes", "Progress",
  ]);
  const SKIP_SECTION_HEADINGS = new Set([
    "Next Steps", "Tags", "TODO", "Blockers", "Notes",
    "Metadata", "Context", "Background",
  ]);

  let pastH1 = false;
  let pastFirstHr = false;
  let currentSection: string | null = null;
  const contentSectionLines: string[] = [];
  const otherH2Headings: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("# ")) {
      pastH1 = true;
      continue;
    }
    if (!pastH1) continue;

    if (!pastFirstHr) {
      if (trimmed === "---") pastFirstHr = true;
      continue;
    }

    if (trimmed.startsWith("## ")) {
      const headingText = trimmed.slice(3).trim();
      if (CONTENT_SECTION_HEADINGS.has(headingText)) {
        currentSection = "content";
      } else if (SKIP_SECTION_HEADINGS.has(headingText)) {
        currentSection = "skip";
      } else {
        currentSection = null;
        otherH2Headings.push(headingText);
      }
      continue;
    }

    if (trimmed.startsWith("#")) continue;
    if (trimmed === "-->") continue;
    if (trimmed.startsWith("<!--") && /^<!--.*-->$/.test(trimmed)) continue;

    if (currentSection === "content" && trimmed.length > 0) {
      const withoutComment = trimmed.replace(/^<!--.*?-->\s*/, "");
      const effective = withoutComment.length > 0 ? withoutComment : trimmed;
      if (effective.length === 0) continue;
      contentSectionLines.push(effective);
    }
  }

  for (const raw of contentSectionLines) {
    const cleaned = cleanMarkdownLine(raw);
    if (!cleaned) continue;
    if (isMetaPhrase(cleaned)) continue;
    if (cleaned.startsWith("<!--") || cleaned.includes("PAI will add")) continue;
    if (cleaned.length < 5) continue;
    return sanitizeName(cleaned);
  }

  for (const heading of otherH2Headings) {
    const cleaned = cleanMarkdownLine(heading);
    if (!cleaned) continue;
    if (isMetaPhrase(cleaned)) continue;
    if (cleaned.length > 3 && cleaned.length < 80) {
      return sanitizeName(cleaned);
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      const title = trimmed.slice(2).trim();
      if (/^Session \d{4}/i.test(title)) continue;
      const cleaned = cleanMarkdownLine(title);
      if (cleaned && !isMetaPhrase(cleaned) && cleaned.length > 3) {
        return sanitizeName(cleaned);
      }
    }
  }

  return "Unnamed Session";
}

/** Format a 4-digit padded session number. */
export function padNum(n: number): string {
  return String(n).padStart(4, "0");
}
