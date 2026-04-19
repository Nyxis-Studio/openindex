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
      const delay = computeDelayMs(error, attempt, config)
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

function computeDelayMs(error: unknown, attempt: number, config: RetryConfig): number {
  const message = String((error as { message?: string })?.message ?? "").toLowerCase()
  const retryAfterMs = parseRetryAfterMs(message)
  if (retryAfterMs > 0) {
    return Math.min(config.maxDelayMs, retryAfterMs + jitterMs())
  }

  const isRateLimit = message.includes("429") || message.includes("too many") || message.includes("rate")
  const multiplier = isRateLimit ? 2 : 1
  const delay = Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, attempt - 1) * multiplier)
  return delay + jitterMs()
}

function parseRetryAfterMs(message: string): number {
  const secondsMatch = message.match(/retry[- ]?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*s/i)
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1])
    if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1000)
  }

  const msMatch = message.match(/retry[- ]?after\s*[:=]?\s*(\d+)\s*ms/i)
  if (msMatch) {
    const ms = Number(msMatch[1])
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms)
  }

  return 0
}

function jitterMs(): number {
  return Math.floor(Math.random() * 250)
}
