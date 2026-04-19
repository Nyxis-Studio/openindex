import { getIndexStatus, testQuery } from "./indexer/inspect"
import { writeLocalIndexerLog } from "./indexer/local-log"
import { runIndexing } from "./indexer/run-indexing"

const reporter = {
  info: (message: string) => {
    console.log(`[info] ${message}`)
    void localLog("info", message)
  },
  success: (message: string) => {
    console.log(`[success] ${message}`)
    void localLog("info", message)
  },
  error: (message: string) => {
    console.error(`[error] ${message}`)
    void localLog("error", message)
  },
  progress: (message: string) => {
    console.log(`[progress] ${message}`)
    void localLog("debug", message)
  },
  log: (message: string, extra?: Record<string, unknown>) => {
    if (extra) console.log(`[log] ${message}`, JSON.stringify(extra))
    else console.log(`[log] ${message}`)
    void localLog("info", message, extra)
  },
}

async function localLog(level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
  try {
    await writeLocalIndexerLog({
      worktree: process.cwd(),
      level,
      source: "cli",
      message,
      ...(extra ? { extra } : {}),
    })
  } catch {
    // Ignore local logger failures in CLI mode.
  }
}

const args = process.argv.slice(2)
const command = args[0] ?? "index"

if (command === "status") {
  const status = await getIndexStatus(process.cwd())
  console.log(JSON.stringify(status))
  process.exit(0)
}

if (command === "test") {
  const query = args.slice(1).join(" ").trim()
  if (!query) {
    console.error('Usage: bun src/cli.ts test "your query"')
    process.exit(1)
  }
  const hits = await testQuery(process.cwd(), query, 5)
  console.log(JSON.stringify({ query, hits }))
  process.exit(0)
}

const summary = await runIndexing(process.cwd(), reporter)
console.log(JSON.stringify(summary))
