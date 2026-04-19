import { readFile, unlink } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { CHUNKING_VERSION } from "./constants"
import { chunkTextByLines } from "./chunker"
import { loadConfig } from "./config"
import { EmbeddingClient, type EmbeddingTelemetryEvent } from "./embedding-client"
import { isLikelyBinary, seemsSensitiveContent } from "./filters"
import { sha256 } from "./hash"
import { scanFiles } from "./scanner"
import { loadState, saveState } from "./state"
import type { IndexSummary, PreparedFile, VectorRecord } from "./types"
import { getProjectVectorStore } from "./vector-store"

export type IndexingReporter = {
  info(message: string): void
  success(message: string): void
  error(message: string): void
  progress(message: string): void
  log(message: string, extra?: Record<string, unknown>): void
}

export async function runIndexing(worktree: string, reporter: IndexingReporter): Promise<IndexSummary> {
  const startedAt = Date.now()
  const config = await loadConfig(worktree)
  await cleanupLegacyArtifacts(worktree)
  const state = await loadState(worktree)

  const metrics = {
    scanDurationMs: 0,
    prepareDurationMs: 0,
    embedDurationMs: 0,
    apiCalls: 0,
    apiFailures: 0,
    apiInputChars: 0,
    apiInputTokens: 0,
    apiEstimatedCostUsd: 0,
  }

  const googleApiKey = process.env[config.googleApiKeyEnv] || config.googleApiKey
  if (!googleApiKey) {
    throw new Error(
      `Missing Google API key. Set ${config.googleApiKeyEnv} in environment or googleApiKey in .index/indexing.config.json`,
    )
  }

  if (config.vectorDb !== "memory") {
    throw new Error(`Unsupported vectorDb '${config.vectorDb}'. Only 'memory' is implemented.`)
  }

  const vectorStore = await getProjectVectorStore(worktree, config.vectorCacheFile)

  const onTelemetry = (event: EmbeddingTelemetryEvent) => {
    if (event.stage === "started") {
      metrics.apiCalls += 1
      metrics.apiInputChars += event.inputChars
    }
    if (event.stage === "failed") {
      metrics.apiFailures += 1
    }
    if (event.stage === "completed") {
      metrics.embedDurationMs += event.durationMs ?? 0
      metrics.apiInputTokens += event.inputTokens ?? 0
      metrics.apiEstimatedCostUsd += event.estimatedCostUsd ?? 0
    }

    if (config.debug.logApiCalls || (config.debug.logCosts && event.stage === "completed")) {
      reporter.log("Embedding API telemetry", {
        operation: event.operation,
        stage: event.stage,
        durationMs: event.durationMs,
        inputChars: event.inputChars,
        inputTokens: event.inputTokens,
        estimatedCostUsd: event.estimatedCostUsd,
        vectorDimension: event.vectorDimension,
        batchSize: event.batchSize,
        model: event.model,
        title: event.title,
        error: event.error,
      })
    }
  }

  const embeddingClient = new EmbeddingClient({
    apiKey: googleApiKey,
    model: config.googleModel,
    retry: config.retry,
    telemetry: onTelemetry,
    costPer1MInputTokensUsd: config.googleEmbeddingCostPer1MInputTokensUsd,
    minIntervalMs: config.googleApiMinIntervalMs,
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
  const scanStartedAt = Date.now()
  const scanned = await scanFiles(worktree, config)
  metrics.scanDurationMs = Date.now() - scanStartedAt
  summary.scannedFiles = scanned.length

  const scannedSet = new Set(scanned.map((f) => f.relativePath))
  const removedPaths = Object.keys(state.files).filter((existing) => !scannedSet.has(existing))
  summary.removedFiles = removedPaths.length

  for (const relativePath of removedPaths) {
    const previous = state.files[relativePath]
    if (previous?.chunkIds?.length) {
      await vectorStore.deleteFile(relativePath)
      summary.deletedChunks += previous.chunkIds.length
    }
    delete state.files[relativePath]
  }

  const prepareStartedAt = Date.now()
  const preparedFiles: PreparedFile[] = []
  for (const file of scanned) {
    const previous = state.files[file.relativePath]
    const content = await readFile(file.absolutePath, "utf8").catch(() => "")
    if (!content) {
      if (previous?.chunkIds?.length) {
        await vectorStore.deleteFile(file.relativePath)
        summary.deletedChunks += previous.chunkIds.length
      }
      delete state.files[file.relativePath]
      summary.skippedFiles += 1
      continue
    }
    if (isLikelyBinary(content)) {
      if (previous?.chunkIds?.length) {
        await vectorStore.deleteFile(file.relativePath)
        summary.deletedChunks += previous.chunkIds.length
      }
      delete state.files[file.relativePath]
      summary.skippedFiles += 1
      continue
    }
    if (seemsSensitiveContent(content)) {
      reporter.log("Skipping file with potential secrets", { path: file.relativePath })
      if (previous?.chunkIds?.length) {
        await vectorStore.deleteFile(file.relativePath)
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
  metrics.prepareDurationMs = Date.now() - prepareStartedAt

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

    const batchSize = Math.max(1, Math.floor(config.googleEmbedBatchSize || 1))
    for (const chunkBatch of batches(file.chunks, batchSize)) {
      const vectors = await embeddingClient.embedDocumentBatch(
        chunkBatch.map((chunk) => ({
          content: chunk.text,
          title: `${file.relativePath}:${chunk.startLine}-${chunk.endLine}`,
        })),
      )

      if (vectors.length !== chunkBatch.length) {
        throw new Error(
          `Embedding batch mismatch for ${file.relativePath}. Expected ${chunkBatch.length} vectors, received ${vectors.length}.`,
        )
      }

      for (let i = 0; i < chunkBatch.length; i += 1) {
        const chunk = chunkBatch[i]
        const values = vectors[i]
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
    }

    await vectorStore.replaceFileRecords(file.relativePath, records, {
      contentHash: file.contentHash,
    })

    const staleIds = file.previousChunkIds.filter((id) => !newChunkIds.includes(id))
    summary.deletedChunks += staleIds.length

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
  if (config.debug.logPerformance || config.debug.logCosts || config.debug.logApiCalls) {
    reporter.log("Indexing metrics", {
      durationMs: Date.now() - startedAt,
      scanDurationMs: metrics.scanDurationMs,
      prepareDurationMs: metrics.prepareDurationMs,
      embedDurationMs: metrics.embedDurationMs,
      apiCalls: metrics.apiCalls,
      apiFailures: metrics.apiFailures,
      apiInputChars: metrics.apiInputChars,
      apiInputTokens: metrics.apiInputTokens,
      apiEstimatedCostUsd: Number(metrics.apiEstimatedCostUsd.toFixed(6)),
      chunksEmbedded: summary.embeddedChunks,
      chunksDeleted: summary.deletedChunks,
      filesChanged: summary.changedFiles,
      vectorsInStore: vectorStore.snapshot().count,
      model: config.googleModel,
      contextCharsIndexedApprox: metrics.apiInputChars,
    })
  }
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

async function cleanupLegacyArtifacts(worktree: string): Promise<void> {
  const stalePaths = [
    resolve(worktree, ".opencode", "index-state.json"),
    resolve(worktree, ".opencode", "vector-cache.json"),
    resolve(worktree, ".opencode", "indexer.log"),
    resolve(worktree, ".index", "indexer.log"),
  ]

  for (const filePath of stalePaths) {
    try {
      await unlink(filePath)
    } catch {
      // Ignore missing legacy artifacts.
    }
  }
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size))
  }
  return result
}
