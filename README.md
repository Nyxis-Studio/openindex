# OpenCode Embedding Cache Plugin

Standalone OpenCode plugin that adds the `/embedding` command.
These commands are scripted and trigger local indexing.

It also adds:

- `/embedding-status` to inspect index status.
- `/embedding-test <query>` to validate semantic retrieval.

Native tool exposed to the agent:

- `index_search` (vector search over local indexed chunks).

Documentation skill included in this repository:

- `skills/index-tool/SKILL.md` (usage guide and troubleshooting).

Automatic indexing:

- on workspace load, the plugin checks and indexes what changed.
- while editing files, it reindexes automatically (with debounce).

## Quick setup

1. Install the plugin globally:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Or install and set the key in one command:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -GoogleApiKey "YOUR_KEY_HERE"
```

2. Set your Google API key:

```powershell
setx GOOGLE_API_KEY "YOUR_KEY_HERE"
```

3. Restart OpenCode and run:

```text
/embedding
```

To monitor and test:

```text
/embedding-status
/embedding-test "high damage champion"
```

To explicitly ask the agent to use the tool:

```text
Use the index_search tool to fetch context about "your query".
```

No per-project setup is required.

The installer copies the plugin to `~/.config/opencode/plugins/embedding-cache-plugin`.
It also installs the global command at `~/.config/opencode/commands/embedding.md`.
These commands execute the plugin CLI script (`bun .../src/cli.ts`).

## What it does

- Scans project files while respecting `.gitignore`.
- Filters binaries, sensitive files, and large files.
- Generates embeddings with Google (`gemini-embedding-001`).
- Keeps vectors in memory during the session.
- Persists project index data locally.

In TUI, command menu entries are also available:

- `Embedding status`
- `Embedding test`

Files created automatically in the target project:

- `.index/state.json`
- `.index/manifest.json`
- `.index/vectors/**/*.json` (per-file shards)

Indexer logs:

- `~/.local/share/opencode/log/embedding-indexer.log`
- optional override: `OPENCODE_INDEXER_LOG_FILE`

## Optional per-project config

To customize behavior, create `.index/indexing.config.json` in the project.
If the file is missing, internal defaults are used.

Optional fields for auto-indexing and telemetry:

```json
{
  "autoIndexOnStartup": true,
  "autoIndexOnChange": true,
  "autoIndexDebounceMs": 1500,
  "googleEmbeddingCostPer1MInputTokensUsd": 0,
  "googleEmbedBatchSize": 16,
  "googleApiMinIntervalMs": 200,
  "debug": {
    "enabled": true,
    "level": "debug",
    "logPerformance": true,
    "logApiCalls": true,
    "logCosts": true
  }
}
```

With debug enabled, `~/.local/share/opencode/log/embedding-indexer.log` records metrics such as:

- cache load time
- total indexing time and stage breakdown
- embedding API calls (start/completion/failure)
- estimated/reported input tokens
- estimated cost (when `googleEmbeddingCostPer1MInputTokensUsd > 0`)
- returned context size in `index_search`

Rate-limit and cost controls:

- `googleEmbedBatchSize`: sends multiple chunks per embedding call (fewer requests).
- `googleApiMinIntervalMs`: minimum delay between embedding calls (helps with 429).
- Retry with exponential backoff + jitter for `429`, `5xx`, and timeouts.
