```bash
# Search federated memory across all projects
pai memory search "cross-encoder reranker"

# Semantic (vector) search with recency boost (reranking is on by default)
pai memory search "token factory" --mode semantic --recency 90

# Re-index a project's memory/ and Notes/ directories
pai memory index

# Show index size and embedding coverage
pai memory status
```
