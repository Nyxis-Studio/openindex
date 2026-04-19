import { GoogleGenAI } from "@google/genai"
import { isTransientHttpError, withRetry } from "./retry"
import type { RetryConfig } from "./types"

export type EmbeddingTelemetryEvent = {
  operation: "document" | "document_batch" | "query"
  stage: "started" | "completed" | "failed"
  durationMs?: number
  inputChars: number
  inputTokens?: number
  estimatedCostUsd?: number
  vectorDimension?: number
  batchSize?: number
  title?: string
  model: string
  error?: string
}

export class EmbeddingClient {
  private readonly client: GoogleGenAI
  private readonly model: string
  private readonly retry: RetryConfig
  private readonly telemetry?: (event: EmbeddingTelemetryEvent) => Promise<void> | void
  private readonly costPer1MInputTokensUsd: number
  private readonly minIntervalMs: number
  private lastRequestAt = 0

  constructor(input: {
    apiKey: string
    model: string
    retry: RetryConfig
    telemetry?: (event: EmbeddingTelemetryEvent) => Promise<void> | void
    costPer1MInputTokensUsd?: number
    minIntervalMs?: number
  }) {
    this.client = new GoogleGenAI({ apiKey: input.apiKey })
    this.model = input.model
    this.retry = input.retry
    this.telemetry = input.telemetry
    this.costPer1MInputTokensUsd = Math.max(0, input.costPer1MInputTokensUsd ?? 0)
    this.minIntervalMs = Math.max(0, input.minIntervalMs ?? 0)
  }

  async embedDocument(content: string, title: string): Promise<number[]> {
    const startedAt = Date.now()
    this.emit({
      operation: "document",
      stage: "started",
      inputChars: content.length,
      title,
      model: this.model,
    })

    try {
      const response = await withRetry(
        async () => {
          await this.waitForRateWindow()
          return this.client.models.embedContent({
            model: this.model,
            contents: content,
            config: {
              taskType: "RETRIEVAL_DOCUMENT",
              title,
            },
          })
        },
        this.retry,
        isTransientHttpError,
      )

      const values = extractValues(response)
      const inputTokens = extractInputTokens(response) ?? estimateTokens(content)
      this.emit({
        operation: "document",
        stage: "completed",
        durationMs: Date.now() - startedAt,
        inputChars: content.length,
        inputTokens,
        estimatedCostUsd: estimateCostUsd(inputTokens, this.costPer1MInputTokensUsd),
        vectorDimension: values.length,
        title,
        model: this.model,
      })
      return values
    } catch (error) {
      this.emit({
        operation: "document",
        stage: "failed",
        durationMs: Date.now() - startedAt,
        inputChars: content.length,
        title,
        model: this.model,
        error: String((error as { message?: string })?.message ?? error),
      })
      throw error
    }
  }

  async embedDocumentBatch(items: Array<{ content: string; title?: string }>): Promise<number[][]> {
    const normalized = items.filter((item) => item.content.trim().length > 0)
    if (normalized.length === 0) return []

    const inputChars = normalized.reduce((acc, item) => acc + item.content.length, 0)
    const startedAt = Date.now()
    this.emit({
      operation: "document_batch",
      stage: "started",
      inputChars,
      batchSize: normalized.length,
      model: this.model,
    })

    try {
      const response = await withRetry(
        async () => {
          await this.waitForRateWindow()
          return this.client.models.embedContent({
            model: this.model,
            contents: normalized.map((item) => item.content),
            config: {
              taskType: "RETRIEVAL_DOCUMENT",
            },
          })
        },
        this.retry,
        isTransientHttpError,
      )

      const vectors = extractMultipleValues(response)
      const inputTokens = extractInputTokens(response) ?? estimateTokensByChars(inputChars)
      this.emit({
        operation: "document_batch",
        stage: "completed",
        durationMs: Date.now() - startedAt,
        inputChars,
        inputTokens,
        estimatedCostUsd: estimateCostUsd(inputTokens, this.costPer1MInputTokensUsd),
        vectorDimension: vectors[0]?.length ?? 0,
        batchSize: normalized.length,
        model: this.model,
      })
      return vectors
    } catch (error) {
      this.emit({
        operation: "document_batch",
        stage: "failed",
        durationMs: Date.now() - startedAt,
        inputChars,
        batchSize: normalized.length,
        model: this.model,
        error: String((error as { message?: string })?.message ?? error),
      })
      throw error
    }
  }

  async embedQuery(query: string): Promise<number[]> {
    const startedAt = Date.now()
    this.emit({
      operation: "query",
      stage: "started",
      inputChars: query.length,
      model: this.model,
    })

    try {
      const response = await withRetry(
        async () => {
          await this.waitForRateWindow()
          return this.client.models.embedContent({
            model: this.model,
            contents: query,
            config: {
              taskType: "RETRIEVAL_QUERY",
            },
          })
        },
        this.retry,
        isTransientHttpError,
      )

      const values = extractValues(response)
      const inputTokens = extractInputTokens(response) ?? estimateTokens(query)
      this.emit({
        operation: "query",
        stage: "completed",
        durationMs: Date.now() - startedAt,
        inputChars: query.length,
        inputTokens,
        estimatedCostUsd: estimateCostUsd(inputTokens, this.costPer1MInputTokensUsd),
        vectorDimension: values.length,
        model: this.model,
      })
      return values
    } catch (error) {
      this.emit({
        operation: "query",
        stage: "failed",
        durationMs: Date.now() - startedAt,
        inputChars: query.length,
        model: this.model,
        error: String((error as { message?: string })?.message ?? error),
      })
      throw error
    }
  }

  private emit(event: EmbeddingTelemetryEvent): void {
    if (!this.telemetry) return
    void this.telemetry(event)
  }

  private async waitForRateWindow(): Promise<void> {
    if (this.minIntervalMs <= 0) return
    const now = Date.now()
    const waitMs = this.lastRequestAt + this.minIntervalMs - now
    if (waitMs > 0) {
      await sleep(waitMs)
    }
    this.lastRequestAt = Date.now()
  }
}

function extractValues(response: unknown): number[] {
  const fromList = (response as { embeddings?: Array<{ values?: number[] }> }).embeddings?.[0]?.values
  if (Array.isArray(fromList) && fromList.length > 0) return fromList

  const fromSingle = (response as { embedding?: { values?: number[] } }).embedding?.values
  if (Array.isArray(fromSingle) && fromSingle.length > 0) return fromSingle

  throw new Error("Embedding API returned empty vector")
}

function extractMultipleValues(response: unknown): number[][] {
  const fromList = (response as { embeddings?: Array<{ values?: number[] }> }).embeddings
  if (Array.isArray(fromList) && fromList.length > 0) {
    const vectors = fromList.map((item) => (Array.isArray(item.values) ? item.values : [])).filter((v) => v.length > 0)
    if (vectors.length > 0) return vectors
  }

  const single = extractValues(response)
  return [single]
}

function extractInputTokens(response: unknown): number | undefined {
  const usageMetadata = (response as { usageMetadata?: Record<string, unknown> }).usageMetadata
  if (usageMetadata && typeof usageMetadata.promptTokenCount === "number") return usageMetadata.promptTokenCount
  if (usageMetadata && typeof usageMetadata.tokens === "number") return usageMetadata.tokens

  const usage = (response as { usage?: Record<string, unknown> }).usage
  if (usage && typeof usage.inputTokens === "number") return usage.inputTokens
  return undefined
}

function estimateTokens(input: string): number {
  return estimateTokensByChars(input.length)
}

function estimateTokensByChars(charCount: number): number {
  return Math.max(1, Math.ceil(charCount / 4))
}

function estimateCostUsd(tokens: number, perMillionUsd: number): number {
  if (perMillionUsd <= 0) return 0
  return (tokens / 1_000_000) * perMillionUsd
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
