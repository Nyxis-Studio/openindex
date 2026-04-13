import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { VectorCacheFile, VectorRecord } from "./types"

const CACHE_VERSION = 1

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>
  deleteByIds(ids: string[]): Promise<void>
  hasAll(ids: string[]): boolean
  flush(model: string): Promise<void>
  allRecords(): VectorRecord[]
  snapshot(): { model: string; dimension: number; updatedAt: string; count: number }
}

export class FileBackedMemoryVectorStore implements VectorStore {
  private readonly path: string
  private readonly records = new Map<string, VectorRecord>()
  private dimension = 0
  private model = ""
  private updatedAt = ""

  private constructor(path: string) {
    this.path = path
  }

  static async load(path: string): Promise<FileBackedMemoryVectorStore> {
    const store = new FileBackedMemoryVectorStore(path)
    const payload = await readCacheFile(path)
    if (payload) {
      store.dimension = payload.dimension
      store.model = payload.model
      store.updatedAt = payload.updatedAt
      for (const record of payload.records) {
        store.records.set(record.id, record)
      }
    }
    return store
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      this.records.set(record.id, record)
      if (this.dimension === 0 && record.values.length > 0) {
        this.dimension = record.values.length
      }
    }
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id)
  }

  hasAll(ids: string[]): boolean {
    if (ids.length === 0) return true
    return ids.every((id) => this.records.has(id))
  }

  async flush(model: string): Promise<void> {
    this.model = model
    this.updatedAt = new Date().toISOString()
    const payload: VectorCacheFile = {
      version: CACHE_VERSION,
      model: this.model,
      dimension: this.dimension,
      updatedAt: this.updatedAt,
      records: Array.from(this.records.values()),
    }
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(payload), "utf8")
  }

  allRecords(): VectorRecord[] {
    return Array.from(this.records.values())
  }

  snapshot() {
    return {
      model: this.model,
      dimension: this.dimension,
      updatedAt: this.updatedAt,
      count: this.records.size,
    }
  }
}

const storesByWorktree = new Map<string, Promise<FileBackedMemoryVectorStore>>()

export async function getProjectVectorStore(worktree: string, cacheFile: string): Promise<FileBackedMemoryVectorStore> {
  const key = resolve(worktree)
  const existing = storesByWorktree.get(key)
  if (existing) return existing

  const absoluteCachePath = resolve(worktree, cacheFile)
  const created = FileBackedMemoryVectorStore.load(absoluteCachePath)
  storesByWorktree.set(key, created)
  return created
}

async function readCacheFile(path: string): Promise<VectorCacheFile | undefined> {
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<VectorCacheFile>
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.records)) return undefined
    return {
      version: typeof parsed.version === "number" ? parsed.version : CACHE_VERSION,
      model: typeof parsed.model === "string" ? parsed.model : "",
      dimension: typeof parsed.dimension === "number" ? parsed.dimension : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      records: parsed.records.filter(isVectorRecord).map((record) => ({ ...record, text: record.text ?? "" })),
    }
  } catch {
    return undefined
  }
}

function isVectorRecord(input: unknown): input is VectorRecord {
  const candidate = input as Partial<VectorRecord>
  return (
    candidate &&
    typeof candidate.id === "string" &&
    Array.isArray(candidate.values) &&
    (typeof candidate.text === "string" || candidate.text === undefined) &&
    typeof candidate.metadata === "object" &&
    candidate.metadata !== null
  )
}
