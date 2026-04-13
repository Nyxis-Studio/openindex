import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { CHUNKING_VERSION } from "./constants"
import { chunkTextByLines } from "./chunker"
import { loadConfig } from "./config"
import { EmbeddingClient } from "./embedding-client"
import { isLikelyBinary, seemsSensitiveContent } from "./filters"
import { sha256 } from "./hash"
import { scanFiles } from "./scanner"
import { loadState, saveState } from "./state"
import type { IndexSummary, PreparedFile, VectorRecord } from "./types"
import { getProjectVectorStore, type VectorStore } from "./vector-store"

export type IndexingReporter = {
  info(message: string): void
  success(message: string): void
  error(message: string): void
  progress(message: string): void
  log(message: string, extra?: Record<string, unknown>): void
}

export async function runIndexing(worktree: string, reporter: IndexingReporter): Promise<IndexSummary> {
  const config = await loadConfig(worktree)
  const state = await loadState(worktree)

  const googleApiKey = process.env[config.googleApiKeyEnv] || config.googleApiKey
  if (!googleApiKey) {
    throw new Error(
      `Missing Google API key. Set ${config.googleApiKeyEnv} in environment or googleApiKey in .opencode/indexing.config.json`,
    )
  }

  if (config.vectorDb !== "memory") {
    throw new Error(`Unsupported vectorDb '${config.vectorDb}'. Only 'memory' is implemented.`)
  }

  const vectorStore = await getProjectVectorStore(worktree, config.vectorCacheFile)

  const embeddingClient = new EmbeddingClient({
    apiKey: googleApiKey,
    model: config.googleModel,
    retry: config.retry,
  })

  const summary: IndexSummary = {
    scannedFiles: 0,
    changedFiles: 0,
    skippedFiles: 0,
    removedFiles: 0,
    totalChunks: 0,
    embeddedChunks: 0,
    deletedChunks: 0,
  }

  reporter.info("Scanning files...")
  const scanned = await scanFiles(worktree, config)
  summary.scannedFiles = scanned.length

  const scannedSet = new Set(scanned.map((f) => f.relativePath))
  const removedPaths = Object.keys(state.files).filter((existing) => !scannedSet.has(existing))
  summary.removedFiles = removedPaths.length

  for (const relativePath of removedPaths) {
    const previous = state.files[relativePath]
    if (previous?.chunkIds?.length) {
      await deleteChunkIds(previous.chunkIds, vectorStore)
      summary.deletedChunks += previous.chunkIds.length
    }
    delete state.files[relativePath]
  }

  const preparedFiles: PreparedFile[] = []
  for (const file of scanned) {
    const previous = state.files[file.relativePath]
    const content = await readFile(file.absolutePath, "utf8").catch(() => "")
    if (!content) {
      if (previous?.chunkIds?.length) {
        await deleteChunkIds(previous.chunkIds, vectorStore)
        summary.deletedChunks += previous.chunkIds.length
      }
      delete state.files[file.relativePath]
      summary.skippedFiles += 1
      continue
    }
    if (isLikelyBinary(content)) {
      if (previous?.chunkIds?.length) {
        await deleteChunkIds(previous.chunkIds, vectorStore)
        summary.deletedChunks += previous.chunkIds.length
      }
      delete state.files[file.relativePath]
      summary.skippedFiles += 1
      continue
    }
    if (seemsSensitiveContent(content)) {
      reporter.log("Skipping file with potential secrets", { path: file.relativePath })
      if (previous?.chunkIds?.length) {
        await deleteChunkIds(previous.chunkIds, vectorStore)
        summary.deletedChunks += previous.chunkIds.length
      }
      delete state.files[file.relativePath]
      summary.skippedFiles += 1
      continue
    }

    const contentHash = sha256(content)
    const unchanged =
      previous &&
      previous.contentHash === contentHash &&
      previous.chunkingVersion === CHUNKING_VERSION &&
      previous.embeddingModel === config.googleModel &&
      vectorStore.hasAll(previous.chunkIds)

    if (unchanged) {
      summary.skippedFiles += 1
      continue
    }

    const chunks = chunkTextByLines({
      text: content,
      chunkSizeBytes: config.chunkSizeBytes,
      overlapLines: config.chunkOverlapLines,
      maxChunks: config.maxChunksPerFile,
    })

    preparedFiles.push({
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      mtimeMs: file.mtimeMs,
      size: file.size,
      contentHash,
      chunks,
      previousChunkIds: previous?.chunkIds ?? [],
    })

    summary.changedFiles += 1
    summary.totalChunks += chunks.length
  }

  let processedChunks = 0
  let lastProgress = -1

  const maybeReportProgress = () => {
    const percent = summary.totalChunks === 0 ? 100 : Math.floor((processedChunks / summary.totalChunks) * 100)
    if (percent >= 100 || percent - lastProgress >= config.progressEveryPercent) {
      lastProgress = percent
      reporter.progress(`Indexing progress: ${percent}% (${processedChunks}/${summary.totalChunks} chunks)`)
    }
  }

  for (const file of preparedFiles) {
    const records: VectorRecord[] = []
    const newChunkIds: string[] = []
    const newChunkHashes: string[] = []

    for (const chunk of file.chunks) {
      const title = `${file.relativePath}:${chunk.startLine}-${chunk.endLine}`
      const values = await embeddingClient.embedDocument(chunk.text, title)
      const id = buildChunkId(file.relativePath, chunk.index, chunk.hash)
      records.push({
        id,
        values,
        text: chunk.text,
        metadata: {
          path: file.relativePath,
          language: inferLanguage(file.relativePath),
          chunk_index: chunk.index,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          chunk_hash: chunk.hash,
          file_hash: file.contentHash,
          source: "opencode-embedding-indexer",
        },
      })
      newChunkIds.push(id)
      newChunkHashes.push(chunk.hash)
      processedChunks += 1
      summary.embeddedChunks += 1
      maybeReportProgress()
    }

    for (const batch of batches(records, 100)) {
      await vectorStore.upsert(batch)
    }

    const staleIds = file.previousChunkIds.filter((id) => !newChunkIds.includes(id))
    if (staleIds.length > 0) {
      await deleteChunkIds(staleIds, vectorStore)
      summary.deletedChunks += staleIds.length
    }

    state.files[file.relativePath] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      contentHash: file.contentHash,
      chunkIds: newChunkIds,
      chunkHashes: newChunkHashes,
      chunkCount: newChunkIds.length,
      chunkingVersion: CHUNKING_VERSION,
      embeddingModel: config.googleModel,
      updatedAt: new Date().toISOString(),
    }
  }

  await saveState(worktree, state)
  await vectorStore.flush(config.googleModel)
  if (summary.totalChunks === 0) {
    reporter.progress("No changed chunks detected.")
  }

  reporter.log("Indexing complete", summary as unknown as Record<string, unknown>)
  return summary
}

function buildChunkId(path: string, chunkIndex: number, chunkHash: string): string {
  const digest = sha256(`${path}:${chunkIndex}:${chunkHash}`).slice(0, 20)
  return `${path}#${chunkIndex}#${digest}`
}

function inferLanguage(path: string): string {
  const extension = extname(path).toLowerCase()
  if (!extension) return "text"
  return extension.slice(1)
}

async function deleteChunkIds(ids: string[], store: VectorStore): Promise<void> {
  for (const batch of batches(ids, 500)) {
    await store.deleteByIds(batch)
  }
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size))
  }
  return result
}
