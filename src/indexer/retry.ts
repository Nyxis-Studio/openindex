import type { RetryConfig } from "./types"

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  shouldRetry: (error: unknown) => boolean,
): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (error) {
      attempt += 1
      if (attempt >= config.attempts || !shouldRetry(error)) throw error
      const delay = Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, attempt - 1))
      await sleep(delay)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isTransientHttpError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message ?? "").toLowerCase()
  return (
    message.includes("429") ||
    message.includes("too many") ||
    message.includes("rate") ||
    message.includes("timeout") ||
    message.includes("econn") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("500")
  )
}
