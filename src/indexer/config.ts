import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { IndexingConfig } from "./types"

const DEFAULT_CONFIG: IndexingConfig = {
  include: ["**/*"],
  exclude: [
    ".git/**",
    ".index/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    "coverage/**",
    ".next/**",
    "out/**",
    "vendor/**",
    "target/**",
  ],
  maxFileSizeBytes: 1024 * 1024,
  chunkSizeBytes: 3072,
  chunkOverlapLines: 8,
  maxChunksPerFile: 300,
  namespace: "default",
  vectorDb: "memory",
  vectorCacheFile: ".index/manifest.json",
  googleModel: "gemini-embedding-001",
  googleApiKey: "",
  googleApiKeyEnv: "GOOGLE_API_KEY",
  googleEmbeddingCostPer1MInputTokensUsd: 0,
  googleEmbedBatchSize: 16,
  googleApiMinIntervalMs: 200,
  autoIndexOnStartup: true,
  autoIndexOnChange: true,
  autoIndexDebounceMs: 1500,
  progressEveryPercent: 5,
  retry: {
    attempts: 5,
    baseDelayMs: 500,
    maxDelayMs: 10000,
  },
  debug: {
    enabled: true,
    level: "debug",
    logPerformance: true,
    logApiCalls: true,
    logCosts: true,
  },
}

export async function loadConfig(worktree: string): Promise<IndexingConfig> {
  const configPath = resolve(worktree, ".index", "indexing.config.json")
  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw) as Partial<IndexingConfig>
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      retry: {
        ...DEFAULT_CONFIG.retry,
        ...(parsed.retry ?? {}),
      },
      debug: {
        ...DEFAULT_CONFIG.debug,
        ...(parsed.debug ?? {}),
      },
    }
  } catch {
    return DEFAULT_CONFIG
  }
}
