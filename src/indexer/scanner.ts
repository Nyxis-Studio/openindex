import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import fg from "fast-glob"
import ignore from "ignore"
import { isSensitivePath, shouldSkipByNameOrExtension } from "./filters"
import type { IndexingConfig } from "./types"

export type ScannedFile = {
  relativePath: string
  absolutePath: string
  size: number
  mtimeMs: number
}

export async function scanFiles(worktree: string, config: IndexingConfig): Promise<ScannedFile[]> {
  const gitIgnore = config.respectGitIgnore ? await loadGitIgnore(worktree) : undefined
  const matches = await fg(config.include, {
    cwd: worktree,
    onlyFiles: true,
    dot: false,
    unique: true,
    ignore: config.exclude,
    followSymbolicLinks: false,
  })

  const result: ScannedFile[] = []
  for (const relativePath of matches) {
    if (gitIgnore?.ignores(relativePath)) continue
    if (isSensitivePath(relativePath)) continue
    if (shouldSkipByNameOrExtension(relativePath)) continue

    const absolutePath = resolve(worktree, relativePath)
    const st = await stat(absolutePath).catch(() => undefined)
    if (!st || !st.isFile()) continue
    if (st.size > config.maxFileSizeBytes) continue

    result.push({
      relativePath,
      absolutePath,
      size: st.size,
      mtimeMs: st.mtimeMs,
    })
  }

  return result
}

async function loadGitIgnore(worktree: string) {
  const gitIgnoreFiles = await fg(["**/.gitignore"], {
    cwd: worktree,
    onlyFiles: true,
    dot: true,
    unique: true,
    ignore: [".git/**", ".index/**", "node_modules/**"],
    followSymbolicLinks: false,
  })

  const matcher = ignore()
  let hasRules = false
  for (const relativeGitIgnorePath of gitIgnoreFiles) {
    const raw = await readFile(resolve(worktree, relativeGitIgnorePath), "utf8").catch(() => "")
    const baseDir = relativeGitIgnorePath.replace(/(^|\/)\.gitignore$/, "")
    const rules = raw
      .split(/\r?\n/)
      .map((line) => normalizeGitIgnoreRule(line, baseDir))
      .filter((line) => line.length > 0)
    if (rules.length > 0) {
      matcher.add(rules)
      hasRules = true
    }
  }

  return hasRules ? matcher : undefined
}

function normalizeGitIgnoreRule(line: string, baseDir: string): string {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return ""
  if (!baseDir) return trimmed

  const negative = trimmed.startsWith("!")
  const rule = negative ? trimmed.slice(1) : trimmed
  const normalized = rule.startsWith("/") ? `${baseDir}${rule}` : `${baseDir}/${rule}`
  return negative ? `!${normalized}` : normalized
}
