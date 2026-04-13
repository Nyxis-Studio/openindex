import { basename, extname } from "node:path"
import { SENSITIVE_FILE_PATTERNS, SKIP_EXTENSIONS, SKIP_FILE_NAMES } from "./constants"

export function isSensitivePath(relativePath: string): boolean {
  const fileName = basename(relativePath)
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(fileName) || pattern.test(relativePath))
}

export function shouldSkipByNameOrExtension(relativePath: string): boolean {
  const fileName = basename(relativePath)
  if (SKIP_FILE_NAMES.has(fileName)) return true

  const extension = extname(fileName).toLowerCase()
  if (SKIP_EXTENSIONS.has(extension)) return true
  if (fileName.toLowerCase().endsWith(".min.js")) return true
  if (fileName.toLowerCase().includes(".generated.")) return true
  if (fileName.toLowerCase().includes(".gen.")) return true

  return false
}

export function isLikelyBinary(content: string): boolean {
  if (!content) return false
  if (content.includes("\u0000")) return true

  const sample = content.slice(0, 2048)
  let suspicious = 0
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i)
    const isTab = code === 9
    const isLf = code === 10
    const isCr = code === 13
    const isPrintable = code >= 32 && code <= 126
    if (!isTab && !isLf && !isCr && !isPrintable) suspicious += 1
  }

  return sample.length > 0 && suspicious / sample.length > 0.15
}

export function seemsSensitiveContent(content: string): boolean {
  const sample = content.slice(0, 20000)
  const patterns = [
    /-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----/i,
    /AKIA[0-9A-Z]{16}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /AIza[0-9A-Za-z\-_]{30,}/,
    /xox[baprs]-[A-Za-z0-9\-]{10,}/,
  ]
  return patterns.some((pattern) => pattern.test(sample))
}
