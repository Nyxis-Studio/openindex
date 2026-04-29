import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./indexer/config"
import { isLevelEnabled, writeLocalIndexerLog } from "./indexer/local-log"
import { indexSearch } from "./indexer/search"
import { runIndexing, type IndexingReporter } from "./indexer/run-indexing"
import { isIndexingLocked } from "./indexer/lock"
import { bootstrapProject } from "./indexer/bootstrap"
import { getIndexStatus, testQuery } from "./indexer/inspect"
import { applyOpenIndexConfig, isOpenIndexCommand } from "./commands"

const PLUGIN_ID = "local.code-embedding-indexer"
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SKILL_PATH = resolve(PLUGIN_ROOT, "skills", "index-tool")

const server: Plugin = async ({ client, worktree }) => {
  let missingApiKeyWarned = false
  let bootstrapWarned = false
  let pendingAutoReasons = new Set<string>()
  let startupScheduled = false
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
      const bootstrap = await bootstrapProject(worktree, { pluginRoot: PLUGIN_ROOT })
      if (!bootstrap.ready) {
        if (!missingApiKeyWarned) {
          missingApiKeyWarned = true
          await log(client, worktree, "warn", "Auto-index skipped: missing Google API key", {
            configPath: bootstrap.configPath,
          })
        }
        return
      }

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
    const bootstrap = await bootstrapProject(worktree, { pluginRoot: PLUGIN_ROOT })
    if (!bootstrap.ready) {
      if (!bootstrapWarned) {
        bootstrapWarned = true
        await log(client, worktree, "warn", "OpenIndex is installed but GOOGLE_API_KEY is not configured", {
          configPath: bootstrap.configPath,
        })
      }
      return
    }

    const config = await loadConfig(worktree)
    if (kind === "startup" && !config.autoIndexOnStartup) return
    if (kind === "change" && !config.autoIndexOnChange) return
    if (kind === "startup") {
      if (startupScheduled) return
      startupScheduled = true
    }

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

  void bootstrapProject(worktree, { pluginRoot: PLUGIN_ROOT })
    .then((status) => {
      void log(client, worktree, "info", "OpenIndex bootstrap checked", {
        ready: status.ready,
        apiKeySource: status.apiKeySource,
        createdConfig: status.createdConfig,
        createdGitignore: status.createdGitignore,
        createdInstallMarker: status.createdInstallMarker,
      })
      if (status.ready) void scheduleAutoIndex("startup", "plugin-load", true)
      else {
        bootstrapWarned = true
        void log(client, worktree, "warn", "OpenIndex installed. Set GOOGLE_API_KEY or run /embedding-setup.", {
          configPath: status.configPath,
        })
      }
    })
    .catch((error) => {
      void log(client, worktree, "error", "OpenIndex bootstrap failed", {
        error: String((error as { message?: string })?.message ?? error),
      })
    })

  return {
    config: async (config) => {
      applyOpenIndexConfig(config as Parameters<typeof applyOpenIndexConfig>[0], { skillPath: SKILL_PATH })
    },
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
      if (!isOpenIndexCommand(input.command)) return

      const reporter: IndexingReporter = {
        info(message) {
          void showToast(client, message, "info")
          void log(client, worktree, "info", message)
        },
        success(message) {
          void showToast(client, message, "success")
          void log(client, worktree, "info", message)
        },
        error(message) {
          void showToast(client, message, "error")
          void log(client, worktree, "error", message)
        },
        progress(message) {
          void showToast(client, message, "info")
          void log(client, worktree, "debug", message)
        },
        log(message, extra) {
          void log(client, worktree, "info", message, extra)
        },
      }

      try {
        if (input.command === "embedding") {
          if (await isIndexingLocked(worktree)) {
            const message = "Another indexing job is already running. Please wait and try again."
            await setCommandOutput(client, input.sessionID, output, message, message)
            return
          }

          await enqueueExclusive(async () => {
            await bootstrapProject(worktree, { pluginRoot: PLUGIN_ROOT })
            await runIndexing(worktree, reporter)
            missingApiKeyWarned = false
          })
          await setCommandOutput(client, input.sessionID, output, "/embedding indexing completed.", "Indexing completed.")
          return
        }

        if (input.command === "embedding-status") {
          const message = await buildStatusMessage(worktree)
          await setCommandOutput(client, input.sessionID, output, message, message)
          return
        }

        if (input.command === "embedding-test") {
          const query = input.arguments.trim()
          if (!query) {
            const message = "Usage: /embedding-test <semantic query>"
            await setCommandOutput(client, input.sessionID, output, message, message)
            return
          }

          const hits = await testQuery(worktree, query, 5)
          const message = formatTestResults(query, hits)
          await setCommandOutput(client, input.sessionID, output, message, message)
          return
        }

        if (input.command === "embedding-setup") {
          const message = await buildSetupMessage(worktree)
          await setCommandOutput(client, input.sessionID, output, message, message)
          return
        }
      } catch (error) {
        const message = `/${input.command} failed: ${String((error as { message?: string })?.message ?? error)}`
        reporter.error(message)
        await setCommandOutput(client, input.sessionID, output, message, message)
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

async function buildStatusMessage(worktree: string): Promise<string> {
  const bootstrap = await bootstrapProject(worktree, { pluginRoot: PLUGIN_ROOT })
  const status = await getIndexStatus(worktree)
  const skillTargets = bootstrap.skillTargetDirs.length > 0 ? bootstrap.skillTargetDirs.join(", ") : "not checked"

  return [
    "OpenIndex status:",
    `Plugin: loaded (${PLUGIN_ID})`,
    "Commands: /embedding, /embedding-status, /embedding-test, /embedding-setup",
    "Tool: index_search registered by plugin server",
    `Skill source: ${bootstrap.skillSourceDir || SKILL_PATH}`,
    `Skill targets: ${skillTargets}`,
    `Project config: ${bootstrap.configPath}`,
    `Project ready: ${bootstrap.ready ? "yes" : "no"}`,
    `Google API key: ${bootstrap.apiKeySource}${bootstrap.apiKeyLocation ? ` (${bootstrap.apiKeyLocation})` : ""}`,
    `Indexed files: ${status.filesIndexed}`,
    `Chunks tracked: ${status.chunksTracked}`,
    `Vectors in memory: ${status.vectorsInMemory}`,
    `Model: ${status.model}`,
    `Updated: ${status.updatedAt || "n/a"}`,
  ].join("\n")
}

async function buildSetupMessage(worktree: string): Promise<string> {
  const bootstrap = await bootstrapProject(worktree, { pluginRoot: PLUGIN_ROOT })
  return [
    "OpenIndex setup:",
    "Set a Google API key using one of these options.",
    "Recommended environment variable:",
    "PowerShell: setx GOOGLE_API_KEY \"YOUR_KEY_HERE\"",
    "macOS/Linux: export GOOGLE_API_KEY=\"YOUR_KEY_HERE\"",
    "Then restart OpenCode Desktop/TUI.",
    "Alternative project config:",
    `Edit ${bootstrap.configPath} and set googleApiKeyFile to a file containing the key.`,
    "Avoid pasting secrets into chat history or command arguments.",
  ].join("\n")
}

function formatTestResults(query: string, hits: Awaited<ReturnType<typeof testQuery>>): string {
  if (hits.length === 0) return `No indexed chunks found for query: ${query}\nRun /embedding first.`

  const lines = [`OpenIndex test results for: ${query}`, ""]
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i]
    const path = String(hit.metadata.path ?? hit.id)
    const start = hit.metadata.start_line ?? "?"
    const end = hit.metadata.end_line ?? "?"
    lines.push(`${i + 1}. ${path}:${start}-${end} (score ${hit.score.toFixed(4)})`)
  }
  return lines.join("\n")
}

async function setCommandOutput(client: any, sessionID: string, output: { parts: unknown[] }, silent: string, visible: string): Promise<void> {
  await postSilentMessage(client, sessionID, silent)
  output.parts = [{ type: "text", text: visible } as any]
}

async function showToast(client: any, message: string, variant: "info" | "success" | "warning" | "error"): Promise<void> {
  try {
    await client.tui.showToast({ body: { message, variant } })
  } catch {
    // Desktop and non-TUI clients may not expose TUI toast APIs.
  }
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
