import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { IndexingConfig } from "./types"

export const DEFAULT_CONFIG: IndexingConfig = {
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
  respectGitIgnore: true,
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
  googleEmbeddingMode: "sync",
  googleEmbedBatchSize: 16,
  googleBatchPollIntervalMs: 5000,
  googleBatchTimeoutMs: 30 * 60 * 1000,
  googleApiMinIntervalMs: 200,
  autoIndexOnStartup: false,
  autoIndexOnChange: true,
  autoIndexDebounceMs: 1500,
  progressEveryPercent: 5,
  retry: {
    attempts: 5,
    baseDelayMs: 500,
    maxDelayMs: 10000,
  },
  debug: {
    enabled: false,
    level: "warn",
    logPerformance: false,
    logApiCalls: false,
    logCosts: false,
  },
}

const INITIAL_PROJECT_CONFIG: Partial<IndexingConfig> = {
  respectGitIgnore: true,
  autoIndexOnStartup: false,
  autoIndexOnChange: true,
  autoIndexDebounceMs: 1500,
  googleModel: "gemini-embedding-002",
  googleEmbeddingMode: "sync",
  googleApiKeyEnv: "GOOGLE_API_KEY",
  googleEmbedBatchSize: 16,
  googleBatchPollIntervalMs: 5000,
  googleBatchTimeoutMs: 30 * 60 * 1000,
  googleApiMinIntervalMs: 200,
  debug: {
    enabled: false,
    level: "warn",
    logPerformance: false,
    logApiCalls: false,
    logCosts: false,
  },
}

export async function loadConfig(worktree: string, input?: { ensureFile?: boolean }): Promise<IndexingConfig> {
  const configPath = resolve(worktree, ".index", "indexing.config.json")
  if (input?.ensureFile ?? false) {
    await ensureProjectConfigFile(worktree, configPath)
  }

  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw) as Partial<IndexingConfig>
    const merged = {
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
    return normalizeConfig(merged)
  } catch {
    return DEFAULT_CONFIG
  }
}

function normalizeConfig(config: IndexingConfig): IndexingConfig {
  return {
    ...config,
    googleEmbeddingMode: config.googleEmbeddingMode === "sync" ? "sync" : "batch",
    googleEmbedBatchSize: Math.max(1, Math.floor(config.googleEmbedBatchSize || 1)),
    googleBatchPollIntervalMs: Math.max(1000, Math.floor(config.googleBatchPollIntervalMs || 5000)),
    googleBatchTimeoutMs: Math.max(1000, Math.floor(config.googleBatchTimeoutMs || 30 * 60 * 1000)),
    googleApiMinIntervalMs: Math.max(0, Math.floor(config.googleApiMinIntervalMs || 0)),
    autoIndexDebounceMs: Math.max(0, Math.floor(config.autoIndexDebounceMs || 0)),
    progressEveryPercent: Math.max(1, Math.min(100, Math.floor(config.progressEveryPercent || 5))),
  }
}

export async function ensureProjectConfigFile(worktree: string, configPath?: string): Promise<boolean> {
  configPath = configPath ?? resolve(worktree, ".index", "indexing.config.json")
  const indexDir = resolve(worktree, ".index")
  await mkdir(indexDir, { recursive: true })

  try {
    await readFile(configPath, "utf8")
    return false
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code && code !== "ENOENT") return false
  }

  const initial = JSON.stringify(INITIAL_PROJECT_CONFIG, null, 2)
  await writeFile(configPath, `${initial}\n`, "utf8")
  return true
}
