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
  const gitIgnore = await loadRootGitIgnore(worktree)
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

async function loadRootGitIgnore(worktree: string) {
  const gitIgnorePath = resolve(worktree, ".gitignore")
  const raw = await readFile(gitIgnorePath, "utf8").catch(() => "")
  if (!raw.trim()) return undefined

  const matcher = ignore()
  matcher.add(raw)
  return matcher
}
