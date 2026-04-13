import { loadConfig } from "./config"
import { loadState } from "./state"
import { indexSearch } from "./search"
import { getProjectVectorStore } from "./vector-store"

export async function getIndexStatus(worktree: string) {
  const config = await loadConfig(worktree)
  const state = await loadState(worktree)
  const store = await getProjectVectorStore(worktree, config.vectorCacheFile)

  const files = Object.values(state.files)
  const totalChunks = files.reduce((acc, file) => acc + file.chunkCount, 0)
  const snapshot = store.snapshot()

  return {
    filesIndexed: files.length,
    chunksTracked: totalChunks,
    vectorsInMemory: snapshot.count,
    model: snapshot.model || config.googleModel,
    dimension: snapshot.dimension,
    updatedAt: snapshot.updatedAt || "",
    cacheFile: config.vectorCacheFile,
  }
}

export async function testQuery(worktree: string, query: string, topK = 5) {
  return indexSearch(worktree, query, topK)
}
