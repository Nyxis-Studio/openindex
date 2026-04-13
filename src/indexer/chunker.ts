import { sha256 } from "./hash"
import type { Chunk } from "./types"

export function chunkTextByLines(input: {
  text: string
  chunkSizeBytes: number
  overlapLines: number
  maxChunks: number
}): Chunk[] {
  const { text, chunkSizeBytes, overlapLines, maxChunks } = input
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")

  if (lines.length === 0) return []

  const chunks: Chunk[] = []
  let lineIndex = 0
  while (lineIndex < lines.length && chunks.length < maxChunks) {
    let bytes = 0
    let end = lineIndex

    while (end < lines.length) {
      const nextLine = lines[end]
      const nextLineBytes = Buffer.byteLength(nextLine + "\n", "utf8")
      if (bytes > 0 && bytes + nextLineBytes > chunkSizeBytes) break
      bytes += nextLineBytes
      end += 1
      if (bytes >= chunkSizeBytes) break
    }

    const slice = lines.slice(lineIndex, end).join("\n").trim()
    if (slice.length > 0) {
      chunks.push({
        index: chunks.length,
        text: slice,
        startLine: lineIndex + 1,
        endLine: end,
        hash: sha256(slice),
      })
    }

    if (end >= lines.length) break

    const nextStart = Math.max(lineIndex + 1, end - Math.max(0, overlapLines))
    lineIndex = nextStart
  }

  return chunks
}
