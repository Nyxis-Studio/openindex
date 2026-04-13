import { GoogleGenAI } from "@google/genai"
import { isTransientHttpError, withRetry } from "./retry"
import type { RetryConfig } from "./types"

export class EmbeddingClient {
  private readonly client: GoogleGenAI
  private readonly model: string
  private readonly retry: RetryConfig

  constructor(input: { apiKey: string; model: string; retry: RetryConfig }) {
    this.client = new GoogleGenAI({ apiKey: input.apiKey })
    this.model = input.model
    this.retry = input.retry
  }

  async embedDocument(content: string, title: string): Promise<number[]> {
    const response = await withRetry(
      () =>
        this.client.models.embedContent({
          model: this.model,
          contents: content,
          config: {
            taskType: "RETRIEVAL_DOCUMENT",
            title,
          },
        }),
      this.retry,
      isTransientHttpError,
    )

    return extractValues(response)
  }

  async embedQuery(query: string): Promise<number[]> {
    const response = await withRetry(
      () =>
        this.client.models.embedContent({
          model: this.model,
          contents: query,
          config: {
            taskType: "RETRIEVAL_QUERY",
          },
        }),
      this.retry,
      isTransientHttpError,
    )

    return extractValues(response)
  }
}

function extractValues(response: unknown): number[] {
  const fromList = (response as { embeddings?: Array<{ values?: number[] }> }).embeddings?.[0]?.values
  if (Array.isArray(fromList) && fromList.length > 0) return fromList

  const fromSingle = (response as { embedding?: { values?: number[] } }).embedding?.values
  if (Array.isArray(fromSingle) && fromSingle.length > 0) return fromSingle

  throw new Error("Embedding API returned empty vector")
}
