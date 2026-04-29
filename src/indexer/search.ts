import { loadConfig } from "./config"
import { EmbeddingClient } from "./embedding-client"
import { writeLocalIndexerLog } from "./local-log"
import { getProjectVectorStore } from "./vector-store"
import { resolveGoogleApiKey } from "./bootstrap"

export type SearchHit = {
  id: string
  score: number
  text: string
  metadata: Record<string, string | number | boolean | string[]>
}

export async function indexSearch(worktree: string, query: string, topK = 5): Promise<SearchHit[]> {
  const startedAt = Date.now()
  const config = await loadConfig(worktree)
  const apiKey = await resolveGoogleApiKey(config)
  if (!apiKey.apiKey) {
    throw new Error(`Missing Google API key. Set ${config.googleApiKeyEnv}, run /embedding-setup, or configure googleApiKeyFile.`)
  }

  const cacheLoadStartedAt = Date.now()
  const store = await getProjectVectorStore(worktree, config.vectorCacheFile)
  const cacheLoadDurationMs = Date.now() - cacheLoadStartedAt
  const records = store.allRecords()
  if (records.length === 0) return []

  let apiDurationMs = 0
  let apiInputTokens = 0
  let apiEstimatedCostUsd = 0

  const embeddingClient = new EmbeddingClient({
    apiKey: apiKey.apiKey,
    model: config.googleModel,
    retry: config.retry,
    minIntervalMs: config.googleApiMinIntervalMs,
    costPer1MInputTokensUsd: config.googleEmbeddingCostPer1MInputTokensUsd,
    telemetry: (event) => {
      if (event.operation !== "query") return
      if (config.debug.logApiCalls || (config.debug.logCosts && event.stage === "completed")) {
        void writeLocalIndexerLog({
          worktree,
          level: "debug",
          source: "embedding-client",
          message: "Embedding API telemetry",
          extra: {
            operation: event.operation,
            stage: event.stage,
            durationMs: event.durationMs,
            inputChars: event.inputChars,
            inputTokens: event.inputTokens,
            estimatedCostUsd: event.estimatedCostUsd,
            model: event.model,
            error: event.error,
          },
        }).catch(() => undefined)
      }

      if (event.stage === "completed") {
        apiDurationMs = event.durationMs ?? 0
        apiInputTokens = event.inputTokens ?? 0
        apiEstimatedCostUsd = event.estimatedCostUsd ?? 0
      }
    },
  })

  const queryStartedAt = Date.now()
  const queryVector = await embeddingClient.embedQuery(query)
  apiDurationMs = Math.max(apiDurationMs, Date.now() - queryStartedAt)

  const hits = records
    .map((record) => ({
      id: record.id,
      score: cosineSimilarity(queryVector, record.values),
      text: record.text,
      metadata: record.metadata,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(topK, 20)))

  await writeLocalIndexerLog({
    worktree,
    level: "debug",
    source: "indexer",
    message: "Index search executed",
    extra: {
      durationMs: Date.now() - startedAt,
      cacheLoadDurationMs,
      apiDurationMs,
      queryChars: query.length,
      apiInputTokens,
      apiEstimatedCostUsd: Number(apiEstimatedCostUsd.toFixed(6)),
      candidates: records.length,
      topK: Math.max(1, Math.min(topK, 20)),
      contextCharsReturned: hits.reduce((acc, hit) => acc + hit.text.length, 0),
    },
  }).catch(() => undefined)

  return hits
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0
  if (a.length !== b.length) return 0
  const size = a.length
  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < size; i += 1) {
    const av = a[i]
    const bv = b[i]
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }

  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
