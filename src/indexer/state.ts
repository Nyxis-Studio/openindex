import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { STATE_VERSION } from "./constants"
import type { IndexState } from "./types"

export function statePath(worktree: string): string {
  return resolve(worktree, ".opencode", "index-state.json")
}

export async function loadState(worktree: string): Promise<IndexState> {
  const path = statePath(worktree)
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<IndexState>
    if (!parsed.files || typeof parsed.files !== "object") {
      return { version: STATE_VERSION, files: {} }
    }
    return {
      version: typeof parsed.version === "number" ? parsed.version : STATE_VERSION,
      files: parsed.files as IndexState["files"],
    }
  } catch {
    return { version: STATE_VERSION, files: {} }
  }
}

export async function saveState(worktree: string, state: IndexState): Promise<void> {
  const path = statePath(worktree)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2), "utf8")
}
