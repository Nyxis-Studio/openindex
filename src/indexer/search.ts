import { loadConfig } from "./config"
import { EmbeddingClient } from "./embedding-client"
import { getProjectVectorStore } from "./vector-store"

export type SearchHit = {
  id: string
  score: number
  text: string
  metadata: Record<string, string | number | boolean | string[]>
}

export async function indexSearch(worktree: string, query: string, topK = 5): Promise<SearchHit[]> {
  const config = await loadConfig(worktree)
  const apiKey = process.env[config.googleApiKeyEnv] || config.googleApiKey
  if (!apiKey) {
    throw new Error(`Missing Google API key. Set ${config.googleApiKeyEnv} or googleApiKey in config.`)
  }

  const store = await getProjectVectorStore(worktree, config.vectorCacheFile)
  const records = store.allRecords()
  if (records.length === 0) return []

  const embeddingClient = new EmbeddingClient({
    apiKey,
    model: config.googleModel,
    retry: config.retry,
  })
  const queryVector = await embeddingClient.embedQuery(query)

  return records
    .map((record) => ({
      id: record.id,
      score: cosineSimilarity(queryVector, record.values),
      text: record.text,
      metadata: record.metadata,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(topK, 20)))
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const size = Math.min(a.length, b.length)
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
