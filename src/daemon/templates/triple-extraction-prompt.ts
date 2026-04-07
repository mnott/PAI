/**
 * triple-extraction-prompt.ts — Prompt template for KG triple extraction.
 *
 * Used by the session-summary-worker to extract structured facts from
 * a completed session summary and store them in the temporal knowledge graph.
 */

export function buildTripleExtractionPrompt(params: {
  sessionContent: string;
  projectSlug: string;
  gitLog: string;
}): string {
  return `Extract atomic facts from this coding session as JSON triples.

A triple has three parts:
- subject: the entity being described (project name, person, file, concept)
- predicate: the relationship (uses, depends_on, version, status, lives_at, decided_to, etc.)
- object: the value or other entity

Output ONLY a JSON array. Each fact must be verifiable from the session content.

Rules:
- Be SPECIFIC: "Glidr uses FSRS algorithm" not "the project uses an algorithm"
- Use snake_case predicates
- Skip opinions, speculation, and "we should" statements
- Skip facts already obvious from project metadata (e.g., "PAI is written in TypeScript" if PAI is the project)
- Maximum 15 triples per session — pick the most important
- Each triple should be a fact that might be queried later

Example output:
[
  {"subject": "Glidr", "predicate": "uses_algorithm", "object": "FSRS"},
  {"subject": "Glidr", "predicate": "shipped_version", "object": "1.0.5"},
  {"subject": "Quassl", "predicate": "platform", "object": "iOS"},
  {"subject": "Matthias", "predicate": "decided_to", "object": "rewrite Quassl in Flutter"}
]

PROJECT: ${params.projectSlug}

SESSION CONTENT:
${params.sessionContent}

GIT COMMITS:
${params.gitLog}

JSON triples:`;
}
