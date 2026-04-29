---
name: index-tool
description: Explains how to use local code indexing with /embedding, /embedding-status, /embedding-test, and the index_search tool.
---

# Index Tool

This skill explains how to operate this OpenCode plugin's local semantic indexing workflow.

## When to Use This Skill

Use this skill when the user:

- Asks how local indexing works
- Wants to know when to use `/embedding` vs `index_search`
- Needs help debugging empty semantic-search results
- Wants to confirm where index files and logs are stored
- Wants to tune auto-indexing or debug telemetry

## What This Plugin Provides

- Command `/embedding`: runs local indexing for workspace files
- Command `/embedding-status`: shows current local index status
- Command `/embedding-test <query>`: validates local semantic retrieval
- Native tool `index_search`: vector search over indexed chunks

## How Indexing Works

High-level flow:

1. Scans project files while respecting `.gitignore`
2. Filters unsupported, sensitive, and oversized files
3. Splits file content into chunks
4. Generates embeddings with Google (`gemini-embedding-002` by default)
5. Persists state and vectors under `.index/`
6. Keeps vector cache in memory for the plugin process

Local index artifacts:

- `.index/indexing.config.json` (auto-created on first use)
- `.index/state.json`
- `.index/manifest.json`
- `.index/vectors/**/*.json`

Do not commit `.index/`; vector shards include source chunk text and embeddings.

Indexer logs:

- `~/.local/share/opencode/log/embedding-indexer.log`
- optional override via `OPENCODE_INDEXER_LOG_FILE`

## How to Use the Commands

Recommended order:

1. Run `/embedding` to index (or reindex)
2. Run `/embedding-status` to verify files/chunks/vectors
3. Run `/embedding-test "your query"` to validate retrieval quality

Examples:

```text
/embedding
/embedding-status
/embedding-test "batch retry rate limit embedding telemetry"
```

## When to Use `index_search`

Use `index_search` when you need semantic code context to answer a user question.

Good practices:

- Refine vague queries with module names, feature names, or error terms
- Start with `topK` between 5 and 8
- If results are empty, run `/embedding` and try again

Tool usage example:

```text
Use the index_search tool to fetch context about "auto indexing in workspace.ready" with topK 5.
```

## Troubleshooting

### No search results

- Run `/embedding` and retry
- Check `/embedding-status` (`vectors`/`chunks` should be greater than 0)
- Ensure the query uses project-relevant terminology
- Check whether the target files are ignored by `.gitignore` (default behavior)

### API key error

- Set `GOOGLE_API_KEY`
- Restart OpenCode after updating environment variables

### Too many 429s / rate limits

- Prefer `googleEmbeddingMode: "batch"` for indexing when latency is not critical
- Increase `googleApiMinIntervalMs` in `.index/indexing.config.json`
- Reduce `googleEmbedBatchSize` if needed
- Check logs for repeated retries

### Logs and debug

- Enable debug in `.index/indexing.config.json`
- Useful fields: `debug.enabled`, `debug.level`, `debug.logPerformance`, `debug.logApiCalls`, `debug.logCosts`

## Operational Notes

- Index data is stored in `.index/` (not `.opencode/`)
- `index_search` depends on existing embeddings in cache
- Auto-indexing can run on startup and file changes, based on config
