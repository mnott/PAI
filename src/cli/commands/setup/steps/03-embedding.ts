/** Step 3: Embedding model selection for semantic search. */

import { c, line, section, type Rl, promptMenu, readConfigRaw } from "../utils.js";

export async function stepEmbedding(rl: Rl): Promise<Record<string, unknown>> {
  section("Step 3: Embedding Model");

  const existing = readConfigRaw();
  if (existing.embeddingModel) {
    console.log(c.ok(`Embedding model: ${existing.embeddingModel}. Skipping.`));
    return { embeddingModel: existing.embeddingModel };
  }

  line();
  line("  An embedding model converts your text into vectors for semantic search.");
  line("  Models are downloaded from HuggingFace on first use.");
  line();

  const choice = await promptMenu(rl, [
    {
      label: "Snowflake Arctic Embed m v1.5",
      description: "768 dims, ~118MB download. Best retrieval quality per MB (MTEB score 55.14). Asymmetric retrieval — different handling for queries vs documents. Best for most users.",
    },
    {
      label: "BGE Small EN v1.5",
      description: "384 dims, ~32MB download. Lightweight and fast. Good for limited disk space or when faster embedding is more important than maximum quality. English only.",
    },
    {
      label: "Nomic Embed Text v1.5",
      description: "768 dims, ~100MB download. 8K token context window — excellent for long documents. Matryoshka dimensions (can truncate for speed/size tradeoffs).",
    },
    {
      label: "None — skip embeddings",
      description: "BM25/keyword search only. No model download needed. You can add embeddings later by running `pai memory embed` after selecting a model.",
    },
  ]);

  const models: Record<number, string | null> = {
    0: "Snowflake/snowflake-arctic-embed-m-v1.5",
    1: "BAAI/bge-small-en-v1.5",
    2: "nomic-ai/nomic-embed-text-v1.5",
    3: null,
  };

  const selectedModel = models[choice];

  line();
  if (selectedModel) {
    console.log(c.ok(`Model selected: ${selectedModel}`));
    console.log(c.dim("  The model will be downloaded on first use of `pai memory embed`."));
  } else {
    console.log(c.ok("Skipping embeddings. Keyword search will still work."));
    console.log(c.dim("  Add later: update embeddingModel in ~/.config/pai/config.json"));
  }

  return { embeddingModel: selectedModel ?? "none" };
}
