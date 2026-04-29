# OpenCode Embedding Cache Plugin

Standalone OpenCode plugin for OpenCode Desktop and TUI that adds local semantic indexing.
Commands are registered by the plugin server at runtime, so they work outside the TUI.

It also adds:

- `/embedding-status` to inspect index status.
- `/embedding-test <query>` to validate semantic retrieval.
- `/embedding-setup` to store a Google API key for OpenIndex.

Native tool exposed to the agent:

- `index_search` (vector search over local indexed chunks).

Documentation skill included in this repository:

- `skills/index-tool/SKILL.md` (usage guide and troubleshooting).

Automatic indexing:

- on workspace load, the plugin checks and indexes what changed.
- while editing files, it reindexes automatically (with debounce).
- on first load, the plugin bootstraps the project-level `.index/` folder.

## Standard plugin setup (recommended)

Add the package name in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@nyxis-studio/openindex"]
}
```

Then set your Google API key in either of these ways.

Recommended environment variable:

```powershell
setx GOOGLE_API_KEY "YOUR_KEY_HERE"
```

Or use the TUI command when running the terminal UI:

```text
/embedding-setup
```

`/embedding-setup` stores the key outside the project at
`~/.config/opencode/openindex/google_api_key` and links the project config to that file.

In OpenCode Desktop, run `/embedding-setup` for setup instructions. Avoid pasting the key
directly into chat history; prefer `GOOGLE_API_KEY` or `googleApiKeyFile`.

Restart OpenCode and run:

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

No manual per-project setup is required. When OpenCode loads the plugin, OpenIndex creates
the required local project files if they do not already exist, injects command definitions,
and exposes the bundled skill path.

When package lifecycle scripts are enabled, installation also copies the `index-tool` skill to
`~/.config/opencode/skills/index-tool` via `scripts/postinstall.mjs`.
At runtime, the plugin copies the skill according to where the plugin was configured:
project config uses `.opencode/skills/index-tool`, while global config uses `~/.config/opencode/skills/index-tool`.

## Manual install fallback

If you prefer manual install from this repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The installer copies the plugin to `~/.config/opencode/plugins/embedding-cache-plugin`, installs
global commands in `~/.config/opencode/commands/`, and installs `index-tool` in `~/.agents/skills/index-tool`.

## What it does

- Scans project files while respecting `.gitignore`.
- Filters binaries, sensitive files, and large files.
- Generates embeddings with Google (`gemini-embedding-002`).
- Keeps vectors in memory during the session.
- Persists project index data locally.

In TUI, command menu entries are also available:

- `Embedding status`
- `Embedding test`

Files created automatically in the target project:

- `.index/.gitignore`
- `.index/indexing.config.json`
- `.index/openindex.install.json`
- `.index/state.json`
- `.index/manifest.json`
- `.index/vectors/**/*.json` (per-file shards)

Do not commit `.index/`. The plugin creates `.index/.gitignore` with `*` to keep config,
state, and vector shards out of Git. Vector shards contain code chunk text and embeddings for local retrieval.

Installation detection:

- if the plugin server/TUI loads, the plugin itself is installed and active.
- `.index/openindex.install.json` records per-project bootstrap status.
- `.index/indexing.config.json` controls indexing behavior.
- commands are injected into OpenCode config by the plugin server: `/embedding`, `/embedding-status`, `/embedding-test`, `/embedding-setup`.
- the native tool `index_search` is registered by the plugin server.
- the bundled skill is exposed from the plugin package and copied to `.opencode/skills/index-tool` for project-scoped plugin configs or `~/.config/opencode/skills/index-tool` for global plugin configs.
- API-key readiness is detected in this order: environment variable, `googleApiKeyFile`, then `googleApiKey`.

If the plugin is installed but no key is configured, auto-indexing is skipped and OpenIndex logs/shows:

```text
OpenIndex installed. Set GOOGLE_API_KEY or run /embedding-setup.
```

Indexer logs:

- `~/.local/share/opencode/log/embedding-indexer.log`
- optional override: `OPENCODE_INDEXER_LOG_FILE`

## Optional per-project config

To customize behavior, create `.index/indexing.config.json` in the project.
On first use, the plugin auto-creates this file with a small editable baseline.
If parsing fails or fields are missing, internal defaults are used as fallback.

Optional fields for auto-indexing and telemetry:

```json
{
  "respectGitIgnore": true,
  "autoIndexOnStartup": false,
  "autoIndexOnChange": true,
  "autoIndexDebounceMs": 1500,
  "googleModel": "gemini-embedding-002",
  "googleApiKeyEnv": "GOOGLE_API_KEY",
  "googleApiKeyFile": "~/.config/opencode/openindex/google_api_key",
  "googleEmbeddingCostPer1MInputTokensUsd": 0,
  "googleEmbeddingMode": "sync",
  "googleEmbedBatchSize": 16,
  "googleBatchPollIntervalMs": 5000,
  "googleBatchTimeoutMs": 1800000,
  "googleApiMinIntervalMs": 200,
  "debug": {
    "enabled": false,
    "level": "warn",
    "logPerformance": false,
    "logApiCalls": false,
    "logCosts": false
  }
}
```

`respectGitIgnore` is enabled by default and skips files ignored by the project's `.gitignore`.

With debug enabled, `~/.local/share/opencode/log/embedding-indexer.log` records metrics such as:

- cache load time
- total indexing time and stage breakdown
- embedding API calls (start/completion/failure)
- estimated/reported input tokens
- estimated cost (when `googleEmbeddingCostPer1MInputTokensUsd > 0`)
- returned context size in `index_search`

Rate-limit and cost controls:

- `googleEmbedBatchSize`: sends multiple chunks per embedding call (fewer requests).
- `googleEmbeddingMode`: `batch` uses the Google Batch API for document indexing; `sync` uses direct `embedContent`.
- `googleBatchPollIntervalMs` / `googleBatchTimeoutMs`: polling controls for asynchronous Batch API jobs.
- `googleApiMinIntervalMs`: minimum delay between embedding calls (helps with 429).
- Retry with exponential backoff + jitter for `429`, `5xx`, and timeouts.
