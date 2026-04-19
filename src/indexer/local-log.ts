import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { loadConfig } from "./config"

const DEDUPE_WINDOW_MS = 2000

const LEVEL_WEIGHT: Record<"debug" | "info" | "warn" | "error", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const recentLogFingerprints = new Map<string, number>()

export async function writeLocalIndexerLog(input: {
  worktree: string
  level: "debug" | "info" | "warn" | "error"
  source: "server" | "tui" | "cli" | "indexer" | "embedding-client"
  message: string
  extra?: Record<string, unknown>
}): Promise<void> {
  if (!(await isLevelEnabled(input.worktree, input.level))) return

  const fingerprint = JSON.stringify({
    source: input.source,
    level: input.level,
    message: input.message,
    extra: input.extra ?? null,
  })
  const now = Date.now()
  const previousAt = recentLogFingerprints.get(fingerprint)
  if (typeof previousAt === "number" && now - previousAt < DEDUPE_WINDOW_MS) {
    return
  }
  recentLogFingerprints.set(fingerprint, now)
  if (recentLogFingerprints.size > 5000) {
    for (const [key, ts] of recentLogFingerprints.entries()) {
      if (now - ts > DEDUPE_WINDOW_MS * 4) recentLogFingerprints.delete(key)
    }
  }

  const path = resolveIndexerLogPath()
  const record = {
    timestamp: new Date().toISOString(),
    level: input.level,
    source: input.source,
    message: input.message,
    ...(input.extra ? { extra: input.extra } : {}),
  }

  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8")
}

export async function isLevelEnabled(
  worktree: string,
  level: "debug" | "info" | "warn" | "error",
): Promise<boolean> {
  const config = await loadConfig(worktree)
  if (!config.debug.enabled) return false
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[config.debug.level]
}

function resolveIndexerLogPath(): string {
  const overrideFile = process.env.OPENCODE_INDEXER_LOG_FILE
  if (overrideFile && overrideFile.trim()) return resolve(overrideFile)

  const opencodeHome = process.env.OPENCODE_HOME
  if (opencodeHome && opencodeHome.trim()) {
    return resolve(opencodeHome, "log", "embedding-indexer.log")
  }

  return resolve(homedir(), ".local", "share", "opencode", "log", "embedding-indexer.log")
}
