export type VectorDb = "memory"

export type RetryConfig = {
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export type IndexingConfig = {
  include: string[]
  exclude: string[]
  maxFileSizeBytes: number
  chunkSizeBytes: number
  chunkOverlapLines: number
  maxChunksPerFile: number
  namespace: string
  vectorDb: VectorDb
  vectorCacheFile: string
  googleModel: string
  googleApiKey?: string
  googleApiKeyEnv: string
  progressEveryPercent: number
  retry: RetryConfig
}

export type FileState = {
  mtimeMs: number
  size: number
  contentHash: string
  chunkIds: string[]
  chunkHashes: string[]
  chunkCount: number
  chunkingVersion: string
  embeddingModel: string
  updatedAt: string
}

export type IndexState = {
  version: number
  files: Record<string, FileState>
}

export type Chunk = {
  index: number
  text: string
  startLine: number
  endLine: number
  hash: string
}

export type PreparedFile = {
  relativePath: string
  absolutePath: string
  mtimeMs: number
  size: number
  contentHash: string
  chunks: Chunk[]
  previousChunkIds: string[]
}

export type VectorRecord = {
  id: string
  values: number[]
  text: string
  metadata: Record<string, string | number | boolean | string[]>
}

export type VectorCacheFile = {
  version: number
  model: string
  dimension: number
  updatedAt: string
  records: VectorRecord[]
}

export type IndexSummary = {
  scannedFiles: number
  changedFiles: number
  skippedFiles: number
  removedFiles: number
  totalChunks: number
  embeddedChunks: number
  deletedChunks: number
}
