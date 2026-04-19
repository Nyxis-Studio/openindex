import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { sha256 } from "./hash"
import { writeLocalIndexerLog } from "./local-log"
import type { VectorManifestFile, VectorManifestFileEntry, VectorRecord, VectorShardFile } from "./types"

const MANIFEST_VERSION = 1
const SHARD_VERSION = 1
const cacheLoadLoggedByManifest = new Set<string>()

export interface VectorStore {
  replaceFileRecords(relativePath: string, records: VectorRecord[], input?: { contentHash?: string }): Promise<void>
  deleteFile(relativePath: string): Promise<void>
  hasAll(ids: string[]): boolean
  flush(model: string): Promise<void>
  allRecords(): VectorRecord[]
  snapshot(): { model: string; dimension: number; updatedAt: string; count: number }
}

type FileEntry = {
  path: string
  shard: string
  chunkCount: number
  contentHash?: string
  updatedAt: string
}

export class FileBackedMemoryVectorStore implements VectorStore {
  private readonly manifestPath: string
  private readonly indexRoot: string
  private readonly records = new Map<string, VectorRecord>()
  private readonly idsByFile = new Map<string, Set<string>>()
  private readonly files = new Map<string, FileEntry>()
  private readonly deletedShards = new Set<string>()
  private dimension = 0
  private model = ""
  private updatedAt = ""

  private constructor(manifestPath: string) {
    this.manifestPath = manifestPath
    this.indexRoot = dirname(manifestPath)
  }

  static async load(manifestPath: string): Promise<FileBackedMemoryVectorStore> {
    const store = new FileBackedMemoryVectorStore(manifestPath)
    const startedAt = Date.now()
    await store.loadFromDisk()
    if (!cacheLoadLoggedByManifest.has(store.manifestPath)) {
      cacheLoadLoggedByManifest.add(store.manifestPath)
      await writeLocalIndexerLog({
        worktree: dirname(store.indexRoot),
        level: "debug",
        source: "indexer",
        message: "Vector store cache loaded",
        extra: {
          durationMs: Date.now() - startedAt,
          filesLoaded: store.files.size,
          vectorsLoaded: store.records.size,
          dimension: store.dimension,
          manifestPath: store.manifestPath,
        },
      }).catch(() => undefined)
    }
    return store
  }

  async replaceFileRecords(relativePath: string, records: VectorRecord[], input?: { contentHash?: string }): Promise<void> {
    this.removeFileFromMemory(relativePath)

    const ids = new Set<string>()
    for (const record of records) {
      this.records.set(record.id, record)
      ids.add(record.id)
      if (this.dimension === 0 && record.values.length > 0) {
        this.dimension = record.values.length
      }
    }

    const previous = this.files.get(relativePath)
    this.idsByFile.set(relativePath, ids)
    this.files.set(relativePath, {
      path: relativePath,
      shard: previous?.shard ?? shardPathForRelativePath(relativePath),
      chunkCount: records.length,
      contentHash: input?.contentHash,
      updatedAt: new Date().toISOString(),
    })
  }

  async deleteFile(relativePath: string): Promise<void> {
    const previous = this.files.get(relativePath)
    if (previous?.shard) this.deletedShards.add(previous.shard)
    this.removeFileFromMemory(relativePath)
  }

  hasAll(ids: string[]): boolean {
    if (ids.length === 0) return true
    return ids.every((id) => this.records.has(id))
  }

  async flush(model: string): Promise<void> {
    const startedAt = Date.now()
    this.model = model
    this.updatedAt = new Date().toISOString()

    let shardWrites = 0
    let shardDeletes = 0

    for (const [path, entry] of this.files.entries()) {
      const shardAbs = this.resolveShardPath(entry.shard)
      const ids = this.idsByFile.get(path) ?? new Set<string>()
      const records = Array.from(ids)
        .map((id) => this.records.get(id))
        .filter((record): record is VectorRecord => Boolean(record))

      const shardPayload: VectorShardFile = {
        version: SHARD_VERSION,
        path,
        model: this.model,
        dimension: this.dimension,
        updatedAt: entry.updatedAt,
        records,
      }

      await mkdir(dirname(shardAbs), { recursive: true })
      await writeFile(shardAbs, JSON.stringify(shardPayload), "utf8")
      this.deletedShards.delete(entry.shard)
      shardWrites += 1
    }

    for (const shard of Array.from(this.deletedShards)) {
      const shardAbs = this.resolveShardPath(shard)
      try {
        await unlink(shardAbs)
      } catch {
        // Ignore missing shard files.
      }
      this.deletedShards.delete(shard)
      shardDeletes += 1
    }

    const manifest: VectorManifestFile = {
      version: MANIFEST_VERSION,
      model: this.model,
      dimension: this.dimension,
      updatedAt: this.updatedAt,
      files: Object.fromEntries(
        Array.from(this.files.entries()).map(([path, entry]) => [
          path,
          {
            path: entry.path,
            shard: entry.shard,
            chunkCount: entry.chunkCount,
            contentHash: entry.contentHash,
            updatedAt: entry.updatedAt,
          } satisfies VectorManifestFileEntry,
        ]),
      ),
    }

    await mkdir(dirname(this.manifestPath), { recursive: true })
    await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8")

    await writeLocalIndexerLog({
      worktree: dirname(this.indexRoot),
      level: "debug",
      source: "indexer",
      message: "Vector store flushed",
      extra: {
        durationMs: Date.now() - startedAt,
        shardWrites,
        shardDeletes,
        indexedFiles: this.files.size,
        vectors: this.records.size,
        model: this.model,
        dimension: this.dimension,
      },
    }).catch(() => undefined)
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

  private async loadFromDisk(): Promise<void> {
    const manifest = await readManifestFile(this.manifestPath)
    if (!manifest) return

    this.model = manifest.model
    this.dimension = manifest.dimension
    this.updatedAt = manifest.updatedAt

    for (const [path, entry] of Object.entries(manifest.files ?? {})) {
      const normalizedEntry: FileEntry = {
        path,
        shard: entry.shard,
        chunkCount: entry.chunkCount,
        contentHash: entry.contentHash,
        updatedAt: entry.updatedAt,
      }
      this.files.set(path, normalizedEntry)

      const shardAbs = this.resolveShardPath(entry.shard)
      const shard = await readShardFile(shardAbs)
      if (!shard) continue

      const ids = new Set<string>()
      for (const record of shard.records) {
        this.records.set(record.id, record)
        ids.add(record.id)
        if (this.dimension === 0 && record.values.length > 0) {
          this.dimension = record.values.length
        }
      }
      this.idsByFile.set(path, ids)
    }
  }

  private removeFileFromMemory(relativePath: string): void {
    const ids = this.idsByFile.get(relativePath)
    if (ids) {
      for (const id of ids) this.records.delete(id)
    }
    this.idsByFile.delete(relativePath)
    this.files.delete(relativePath)
  }

  private resolveShardPath(shardRelativePath: string): string {
    return resolve(this.indexRoot, shardRelativePath)
  }
}

const storesByWorktree = new Map<string, Promise<FileBackedMemoryVectorStore>>()

export async function getProjectVectorStore(worktree: string, manifestFile: string): Promise<FileBackedMemoryVectorStore> {
  const key = resolve(worktree)
  const existing = storesByWorktree.get(key)
  if (existing) return existing

  const absoluteManifestPath = resolve(worktree, manifestFile)
  const created = FileBackedMemoryVectorStore.load(absoluteManifestPath)
  storesByWorktree.set(key, created)
  return created
}

function shardPathForRelativePath(relativePath: string): string {
  const digest = sha256(relativePath)
  const prefix = digest.slice(0, 2)
  return join("vectors", prefix, `${digest}.json`).replace(/\\/g, "/")
}

async function readManifestFile(path: string): Promise<VectorManifestFile | undefined> {
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<VectorManifestFile>
    if (!parsed || typeof parsed !== "object") return undefined
    if (!parsed.files || typeof parsed.files !== "object") return undefined

    const files: Record<string, VectorManifestFileEntry> = {}
    for (const [key, value] of Object.entries(parsed.files)) {
      if (!isManifestEntry(value)) continue
      files[key] = {
        path: value.path,
        shard: value.shard,
        chunkCount: value.chunkCount,
        contentHash: value.contentHash,
        updatedAt: value.updatedAt,
      }
    }

    return {
      version: typeof parsed.version === "number" ? parsed.version : MANIFEST_VERSION,
      model: typeof parsed.model === "string" ? parsed.model : "",
      dimension: typeof parsed.dimension === "number" ? parsed.dimension : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      files,
    }
  } catch {
    return undefined
  }
}

async function readShardFile(path: string): Promise<VectorShardFile | undefined> {
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<VectorShardFile>
    if (!parsed || typeof parsed !== "object") return undefined
    if (!Array.isArray(parsed.records)) return undefined
    return {
      version: typeof parsed.version === "number" ? parsed.version : SHARD_VERSION,
      path: typeof parsed.path === "string" ? parsed.path : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      dimension: typeof parsed.dimension === "number" ? parsed.dimension : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      records: parsed.records.filter(isVectorRecord).map((record) => ({ ...record, text: record.text ?? "" })),
    }
  } catch {
    return undefined
  }
}

function isManifestEntry(input: unknown): input is VectorManifestFileEntry {
  const candidate = input as Partial<VectorManifestFileEntry>
  return (
    candidate &&
    typeof candidate.path === "string" &&
    typeof candidate.shard === "string" &&
    typeof candidate.chunkCount === "number" &&
    typeof candidate.updatedAt === "string"
  )
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
