import { getIndexStatus, testQuery } from "./indexer/inspect"
import { runIndexing } from "./indexer/run-indexing"

const reporter = {
  info: (message: string) => console.log(`[info] ${message}`),
  success: (message: string) => console.log(`[success] ${message}`),
  error: (message: string) => console.error(`[error] ${message}`),
  progress: (message: string) => console.log(`[progress] ${message}`),
  log: (message: string, extra?: Record<string, unknown>) => {
    if (extra) console.log(`[log] ${message}`, JSON.stringify(extra))
    else console.log(`[log] ${message}`)
  },
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
