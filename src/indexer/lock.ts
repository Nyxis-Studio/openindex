import { mkdir, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const LOCK_STALE_MS = 10 * 60 * 1000
const LOCK_WAIT_MS = 30 * 60 * 1000
const LOCK_RETRY_MS = 250

export async function withIndexingLock<T>(worktree: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = resolve(worktree, ".index", "indexing.lock")
  const startedAt = Date.now()
  let handle: FileHandle | undefined

  while (!handle) {
    await mkdir(dirname(lockPath), { recursive: true })
    try {
      handle = await open(lockPath, "wx")
      await writeFile(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8")
      break
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code !== "EEXIST") throw error

      if (await isStaleLock(lockPath)) {
        await unlink(lockPath).catch(() => undefined)
        continue
      }

      if (Date.now() - startedAt > LOCK_WAIT_MS) {
        throw new Error("Timed out waiting for another indexing job to finish")
      }
      await sleep(LOCK_RETRY_MS)
    }
  }

  try {
    return await fn()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

export async function isIndexingLocked(worktree: string): Promise<boolean> {
  const lockPath = resolve(worktree, ".index", "indexing.lock")
  try {
    await open(lockPath, "r")
    return await isStaleLock(lockPath).then((stale) => !stale)
  } catch {
    return false
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, "utf8")
    const parsed = JSON.parse(raw) as { createdAt?: string }
    const createdAt = parsed.createdAt ? Date.parse(parsed.createdAt) : 0
    return !Number.isFinite(createdAt) || Date.now() - createdAt > LOCK_STALE_MS
  } catch {
    return true
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
