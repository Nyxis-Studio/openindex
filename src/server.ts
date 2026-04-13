import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin"
import { indexSearch } from "./indexer/search"
import { runIndexing, type IndexingReporter } from "./indexer/run-indexing"

const PLUGIN_ID = "local.code-embedding-indexer-server"

const server: Plugin = async ({ client, worktree }) => {
  return {
    tool: {
      index_search: tool({
        description: "Search indexed code chunks from local vector cache",
        args: {
          query: tool.schema.string().describe("Natural language query to search in indexed chunks"),
          topK: tool.schema.number().int().min(1).max(20).optional().describe("Number of chunks to return (default 5)"),
        },
        async execute(args, context) {
          const hits = await indexSearch(context.worktree, args.query, args.topK ?? 5)
          if (hits.length === 0) {
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

          return lines.join("\n")
        },
      }),
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "embedding") return

      const reporter: IndexingReporter = {
        info(message) {
          void client.tui.showToast({ body: { message, variant: "info" } })
          void log(client, "info", message)
        },
        success(message) {
          void client.tui.showToast({ body: { message, variant: "success" } })
          void log(client, "info", message)
        },
        error(message) {
          void client.tui.showToast({ body: { message, variant: "error" } })
          void log(client, "error", message)
        },
        progress(message) {
          void client.tui.showToast({ body: { message, variant: "info" } })
          void log(client, "debug", message)
        },
        log(message, extra) {
          void log(client, "info", message, extra)
        },
      }

      try {
        await runIndexing(worktree, reporter)
        await postSilentMessage(client, input.sessionID, "Indexacao /embedding concluida.")
        output.parts = [
          {
            type: "text",
            text: "A indexacao local foi executada. Responda em uma linha: Indexacao concluida.",
          } as any,
        ]
      } catch (error) {
        const message = `Indexacao /embedding falhou: ${String((error as { message?: string })?.message ?? error)}`
        reporter.error(message)
        await postSilentMessage(client, input.sessionID, message)
        output.parts = [
          {
            type: "text",
            text: "A indexacao falhou. Responda em uma linha pedindo para verificar os logs.",
          } as any,
        ]
      }
    },
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
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
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
