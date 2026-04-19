import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin"
import { isAbsolute, relative, resolve } from "node:path"
import { loadConfig } from "./indexer/config"
import { isLevelEnabled, writeLocalIndexerLog } from "./indexer/local-log"
import { indexSearch } from "./indexer/search"
import { runIndexing, type IndexingReporter } from "./indexer/run-indexing"

const PLUGIN_ID = "local.code-embedding-indexer-server"

const server: Plugin = async ({ client, worktree }) => {
  let missingApiKeyWarned = false
  let pendingAutoReasons = new Set<string>()
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let tail = Promise.resolve()

  const enqueueExclusive = async <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const backgroundReporter: IndexingReporter = {
    info(message) {
      void log(client, worktree, "info", message)
    },
    success(message) {
      void log(client, worktree, "info", message)
    },
    error(message) {
      void log(client, worktree, "error", message)
    },
    progress(message) {
      void log(client, worktree, "debug", message)
    },
    log(message, extra) {
      void log(client, worktree, "info", message, extra)
    },
  }

  const runAutoIndexNow = async (): Promise<void> => {
    const reasons = Array.from(pendingAutoReasons)
    pendingAutoReasons = new Set<string>()

    await enqueueExclusive(async () => {
      await log(client, worktree, "debug", "Auto-index job started", {
        reason: reasons.join(", ") || "unknown",
      })

      try {
        await runIndexing(worktree, backgroundReporter)
        missingApiKeyWarned = false
      } catch (error) {
        const message = String((error as { message?: string })?.message ?? error)
        if (message.includes("Missing Google API key")) {
          if (!missingApiKeyWarned) {
            missingApiKeyWarned = true
            await log(client, worktree, "warn", "Auto-index skipped: missing Google API key")
          }
          return
        }
        await log(client, worktree, "error", `Auto-index failed: ${message}`)
      }
    })
  }

  const scheduleAutoIndex = async (kind: "startup" | "change", reason: string, immediate = false): Promise<void> => {
    const config = await loadConfig(worktree)
    if (kind === "startup" && !config.autoIndexOnStartup) return
    if (kind === "change" && !config.autoIndexOnChange) return

    pendingAutoReasons.add(reason)

    if (autoTimer) {
      clearTimeout(autoTimer)
      autoTimer = undefined
    }

    const debounceMs = Math.max(0, Math.floor(config.autoIndexDebounceMs))
    if (immediate || debounceMs === 0) {
      void runAutoIndexNow()
      return
    }

    autoTimer = setTimeout(() => {
      autoTimer = undefined
      void runAutoIndexNow()
    }, debounceMs)
  }

  const handleWatcherEvent = async (file: unknown): Promise<void> => {
    const normalized = normalizeWatcherPath(worktree, file)
    if (!normalized) return

    if (normalized === ".gitignore" || normalized === ".index/indexing.config.json") {
      await scheduleAutoIndex("change", `watch:${normalized}`, true)
      return
    }

    if (shouldIgnoreWatcherPath(normalized)) return
    await scheduleAutoIndex("change", `watch:${normalized}`, false)
  }

  void scheduleAutoIndex("startup", "plugin-load", true)

  return {
    tool: {
      index_search: tool({
        description: "Search indexed code chunks from local vector cache",
        args: {
          query: tool.schema.string().describe("Natural language query to search in indexed chunks"),
          topK: tool.schema.number().int().min(1).max(20).optional().describe("Number of chunks to return (default 5)"),
        },
        async execute(args, context) {
          const startedAt = Date.now()
          const hits = await indexSearch(context.worktree, args.query, args.topK ?? 5)
          if (hits.length === 0) {
            await log(client, worktree, "debug", "index_search returned no results", {
              queryChars: args.query.length,
              topK: args.topK ?? 5,
              durationMs: Date.now() - startedAt,
            })
            return "No indexed chunks found. Run /embedding first."
          }

          const lines = [
            `Results for query: ${args.query}`,
            "",
          ]

          for (let i = 0; i < hits.length; i += 1) {
            const hit = hits[i]
            const path = String(hit.metadata.path ?? hit.id)
            const start = hit.metadata.start_line ?? "?"
            const end = hit.metadata.end_line ?? "?"
            lines.push(`Chunk ${i + 1}: ${path}:${start}-${end}`)
            lines.push(`Score: ${hit.score.toFixed(4)}`)
            lines.push("```text")
            lines.push((hit.text || "").slice(0, 1600))
            lines.push("```")
            lines.push("")
          }

          await log(client, worktree, "debug", "index_search executed", {
            queryChars: args.query.length,
            topK: args.topK ?? 5,
            hits: hits.length,
            contextCharsReturned: hits.reduce((acc, hit) => acc + (hit.text?.length ?? 0), 0),
            durationMs: Date.now() - startedAt,
          })

          return lines.join("\n")
        },
      }),
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "embedding") return

      const reporter: IndexingReporter = {
        info(message) {
          void client.tui.showToast({ body: { message, variant: "info" } })
          void log(client, worktree, "info", message)
        },
        success(message) {
          void client.tui.showToast({ body: { message, variant: "success" } })
          void log(client, worktree, "info", message)
        },
        error(message) {
          void client.tui.showToast({ body: { message, variant: "error" } })
          void log(client, worktree, "error", message)
        },
        progress(message) {
          void client.tui.showToast({ body: { message, variant: "info" } })
          void log(client, worktree, "debug", message)
        },
        log(message, extra) {
          void log(client, worktree, "info", message, extra)
        },
      }

      try {
        await enqueueExclusive(async () => {
          await runIndexing(worktree, reporter)
          missingApiKeyWarned = false
        })
        await postSilentMessage(client, input.sessionID, "/embedding indexing completed.")
        output.parts = [
          {
            type: "text",
            text: "Local indexing has been executed. Reply in one line: Indexing completed.",
          } as any,
        ]
      } catch (error) {
        const message = `/embedding indexing failed: ${String((error as { message?: string })?.message ?? error)}`
        reporter.error(message)
        await postSilentMessage(client, input.sessionID, message)
        output.parts = [
          {
            type: "text",
            text: "Indexing failed. Reply in one line asking to check the logs.",
          } as any,
        ]
      }
    },
    event: async ({ event }) => {
      const eventType = (event as { type?: string }).type ?? ""
      switch (eventType) {
        case "workspace.ready":
        case "worktree.ready": {
          await scheduleAutoIndex("startup", eventType, true)
          return
        }
        case "file.watcher.updated": {
          const payload = (event as { properties?: { file?: unknown; event?: string } }).properties ?? {}
          await handleWatcherEvent(payload.file)
          return
        }
        default:
          return
      }
    },
  }
}

function normalizeWatcherPath(worktree: string, file: unknown): string {
  if (typeof file !== "string" || !file.trim()) return ""

  const absolute = isAbsolute(file) ? file : resolve(worktree, file)
  const rel = relative(worktree, absolute)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return ""

  return rel.replace(/\\/g, "/")
}

function shouldIgnoreWatcherPath(relativePath: string): boolean {
  if (!relativePath) return true
  if (relativePath.startsWith(".git/")) return true
  if (relativePath.startsWith(".index/")) return true
  return false
}

async function postSilentMessage(client: any, sessionID: string, content: string): Promise<void> {
  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text: content }],
      },
    })
  } catch {
    // Ignore chat update failures.
  }
}

async function log(
  client: any,
  worktree: string,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const enabled = await isLevelEnabled(worktree, level)
  if (!enabled) return

  try {
    await writeLocalIndexerLog({
      worktree,
      level,
      source: "server",
      message,
      ...(extra ? { extra } : {}),
    })
  } catch {
    // Ignore local logger failures.
  }

  try {
    await client.app.log({
      body: {
        service: "code-indexer",
        level,
        message,
        ...(extra ? { extra } : {}),
      },
    })
  } catch {
    // Ignore logger failures.
  }
}

const moduleExport: PluginModule = {
  id: PLUGIN_ID,
  server,
}

export default moduleExport
