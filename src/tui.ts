import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { getIndexStatus, testQuery } from "./indexer/inspect"
import { runIndexing, type IndexingReporter } from "./indexer/run-indexing"
import { loadConfig } from "./indexer/config"
import { isLevelEnabled, writeLocalIndexerLog } from "./indexer/local-log"
import { getProjectVectorStore } from "./indexer/vector-store"

const PLUGIN_ID = "local.code-embedding-indexer"

const tui: TuiPlugin = async (api) => {
  let running = false
  const worktree = api.state.path.worktree

  void prewarmVectorCache(api, worktree)

  const unregister = api.command.register(() => [
    {
      title: "Index code embeddings",
      value: "embedding-index",
      description: "Index the current project into local in-memory and file cache",
      category: "Codebase",
      slash: {
        name: "embedding",
      },
      onSelect: () => {
        if (running) {
          api.ui.toast({
            variant: "warning",
            message: "Indexing already running.",
          })
          return
        }

        running = true
        void run(api, {
          onFinish: () => {
            running = false
          },
        })
      },
    },
    {
      title: "Embedding status",
      value: "embedding-status",
      description: "Show current indexing status and cache stats",
      category: "Codebase",
      slash: {
        name: "embedding-status",
      },
      onSelect: () => {
        void showStatus(api)
      },
    },
    {
      title: "Embedding test",
      value: "embedding-test",
      description: "Run a semantic test query against indexed vectors",
      category: "Codebase",
      slash: {
        name: "embedding-test",
      },
      onSelect: () => {
        openTestDialog(api)
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    unregister()
  })
}

async function showStatus(api: Parameters<TuiPlugin>[0]): Promise<void> {
  try {
    const status = await getIndexStatus(api.state.path.worktree)
    const message =
      `Indexed files: ${status.filesIndexed}, chunks: ${status.chunksTracked}, ` +
      `vectors: ${status.vectorsInMemory}, model: ${status.model}`
    api.ui.toast({ variant: "info", message })
    await postSilentMessage(api, currentSessionID(api), `${message}. Updated: ${status.updatedAt || "n/a"}.`)
    await log(api, "info", "Embedding status viewed", status as unknown as Record<string, unknown>)
  } catch (error) {
    const message = `Failed to read embedding status: ${String((error as { message?: string })?.message ?? error)}`
    api.ui.toast({ variant: "error", message })
    await log(api, "error", message)
  }
}

function openTestDialog(api: Parameters<TuiPlugin>[0]): void {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Embedding test query",
      placeholder: "Type a query to test retrieval",
      onCancel: () => api.ui.dialog.clear(),
      onConfirm: (value) => {
        api.ui.dialog.clear()
        const query = value.trim()
        if (!query) {
          api.ui.toast({ variant: "warning", message: "Type a query to run the test." })
          return
        }
        void runTest(api, query)
      },
    }),
  )
}

async function runTest(api: Parameters<TuiPlugin>[0], query: string): Promise<void> {
  try {
    const hits = await testQuery(api.state.path.worktree, query, 5)
    if (hits.length === 0) {
      api.ui.toast({ variant: "warning", message: "No vectors indexed yet. Run /embedding first." })
      await postSilentMessage(api, currentSessionID(api), "No vectors indexed yet. Run /embedding first.")
      return
    }

    const preview = hits
      .map((hit, index) => {
        const path = String(hit.metadata.path ?? hit.id)
        const score = Number(hit.score).toFixed(4)
        return `${index + 1}. ${path} (score ${score})`
      })
      .join("\n")

    api.ui.toast({ variant: "success", message: `Embedding test completed (${hits.length} hits).` })
    await postSilentMessage(api, currentSessionID(api), `Embedding test results for: "${query}"\n${preview}`)
    await log(api, "info", "Embedding test query executed", { query, hits: hits.length })
  } catch (error) {
    const message = `Embedding test failed: ${String((error as { message?: string })?.message ?? error)}`
    api.ui.toast({ variant: "error", message })
    await log(api, "error", message)
  }
}

async function prewarmVectorCache(api: Parameters<TuiPlugin>[0], worktree: string): Promise<void> {
  try {
    const config = await loadConfig(worktree)
    await getProjectVectorStore(worktree, config.vectorCacheFile)
    await log(api, "info", "Vector cache loaded in memory", { cacheFile: config.vectorCacheFile })
  } catch (error) {
    await log(api, "warn", "Failed to prewarm vector cache", {
      error: String((error as { message?: string })?.message ?? error),
    })
  }
}

async function run(api: Parameters<TuiPlugin>[0], input: { onFinish: () => void }): Promise<void> {
  const startedAt = Date.now()
  const worktree = api.state.path.worktree
  const sessionID = currentSessionID(api)

  const reporter: IndexingReporter = {
    info(message) {
      api.ui.toast({ variant: "info", message })
      void log(api, "info", message)
    },
    success(message) {
      api.ui.toast({ variant: "success", message })
      void log(api, "info", message)
    },
    error(message) {
      api.ui.toast({ variant: "error", message })
      void log(api, "error", message)
    },
    progress(message) {
      api.ui.toast({ variant: "info", message })
      void log(api, "debug", message)
    },
    log(message, extra) {
      void log(api, "info", message, extra)
    },
  }

  try {
    reporter.info("Starting codebase indexing...")
    await postSilentMessage(api, sessionID, "Indexing started via /embedding")

    const summary = await runIndexing(worktree, reporter)
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)

    const finalMessage =
      `Indexing completed in ${elapsedSeconds}s. ` +
      `${summary.scannedFiles} files scanned, ` +
      `${summary.changedFiles} changed, ` +
      `${summary.embeddedChunks} chunks embedded, ` +
      `${summary.deletedChunks} chunks deleted.`

    reporter.success(finalMessage)
    await postSilentMessage(api, sessionID, finalMessage)
  } catch (error) {
    const message = `Indexing failed: ${String((error as { message?: string })?.message ?? error)}`
    reporter.error(message)
    await postSilentMessage(api, sessionID, message)
  } finally {
    input.onFinish()
  }
}

function currentSessionID(api: Parameters<TuiPlugin>[0]): string | undefined {
  const current = api.route.current as { name?: string; params?: Record<string, unknown> }
  if (current?.name !== "session") return undefined
  const candidate = current.params?.sessionID
  return typeof candidate === "string" ? candidate : undefined
}

async function postSilentMessage(
  api: Parameters<TuiPlugin>[0],
  sessionID: string | undefined,
  content: string,
): Promise<void> {
  if (!sessionID) return
  try {
    await (api.client as any).session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text: content }],
      },
    })
  } catch {
    // Ignore prompt failures to keep indexing flow resilient.
  }
}

async function log(
  api: Parameters<TuiPlugin>[0],
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const worktree = api.state.path.worktree
  const enabled = await isLevelEnabled(worktree, level)
  if (!enabled) return

  try {
    await writeLocalIndexerLog({
      worktree,
      level,
      source: "tui",
      message,
      ...(extra ? { extra } : {}),
    })
  } catch {
    // Avoid hard failure when local logger is unavailable.
  }

  try {
    await (api.client as any).app.log({
      body: {
        service: "code-indexer",
        level,
        message,
        ...(extra ? { extra } : {}),
      },
    })
  } catch {
    // Avoid hard failure when logger is unavailable.
  }
}

const moduleExport: TuiPluginModule = {
  id: PLUGIN_ID,
  tui,
}

export default moduleExport
