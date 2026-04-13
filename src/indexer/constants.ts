export const CHUNKING_VERSION = "v1"
export const STATE_VERSION = 1

export const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /id_rsa/i,
  /id_dsa/i,
  /credentials/i,
  /secret/i,
  /token/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
]

export const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".mp4",
  ".mp3",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".jar",
  ".class",
  ".dll",
  ".exe",
  ".so",
  ".dylib",
  ".wasm",
  ".bin",
  ".lock",
  ".min.js",
])

export const SKIP_FILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
])
