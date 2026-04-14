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
  return `Extract structured entities and relations from this coding session.

Output a single JSON object with two arrays: "entities" and "relations".

Entity types: project | person | concept | tool | file | version | decision | technology | organization

Rules:
- Be SPECIFIC: entity names must be concrete (e.g., "FSRS", "Glidr", "Matthias")
- Use snake_case relation verb phrases (e.g., "uses_algorithm", "decided_to", "shipped_version")
- Skip opinions, speculation, and "we should" statements
- Skip entities obvious from project metadata unless they have a meaningful relation
- Maximum 15 relations per session — pick the most important
- Each entity should have a brief description (1 sentence, what it is in this context)
- Each relation must reference entity names that appear in the entities array

Example output:
{
  "entities": [
    {"name": "Glidr", "type": "project", "description": "Flashcard app using FSRS spaced repetition"},
    {"name": "FSRS", "type": "concept", "description": "Free Spaced Repetition Scheduler algorithm"},
    {"name": "Matthias", "type": "person", "description": "Developer of Glidr and Quassl"},
    {"name": "Quassl", "type": "project", "description": "iOS app being rewritten in Flutter"},
    {"name": "Flutter", "type": "technology", "description": "Cross-platform mobile framework"}
  ],
  "relations": [
    {"source": "Glidr", "relation": "uses_algorithm", "target": "FSRS"},
    {"source": "Glidr", "relation": "shipped_version", "target": "1.0.5"},
    {"source": "Matthias", "relation": "decided_to_rewrite", "target": "Quassl"},
    {"source": "Quassl", "relation": "migrating_to", "target": "Flutter"}
  ]
}

PROJECT: ${params.projectSlug}

SESSION CONTENT:
${params.sessionContent}

GIT COMMITS:
${params.gitLog}

JSON object (entities + relations):`;
}
