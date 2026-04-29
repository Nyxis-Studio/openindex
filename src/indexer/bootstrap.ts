import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"
import { DEFAULT_CONFIG, ensureProjectConfigFile, loadConfig } from "./config"
import type { IndexingConfig } from "./types"

const PLUGIN_NAME = "@nyxis-studio/openindex"
const PLUGIN_VERSION = "0.1.0"
const INSTALL_SCHEMA_VERSION = 1

export type ApiKeySource = "env" | "file" | "config" | "missing"

export type ApiKeyResolution = {
  apiKey: string
  source: Exclude<ApiKeySource, "missing">
  location: string
} | {
  apiKey: ""
  source: "missing"
  location: ""
}

export type BootstrapStatus = {
  indexDir: string
  configPath: string
  gitignorePath: string
  installMarkerPath: string
  createdIndexDir: boolean
  createdConfig: boolean
  createdGitignore: boolean
  createdInstallMarker: boolean
  apiKeySource: ApiKeySource
  apiKeyLocation: string
  skillSourceDir: string
  skillTargetDirs: string[]
  installedSkillDirs: string[]
  ready: boolean
}

type InstallMarker = {
  plugin: string
  version: string
  schemaVersion: number
  installedAt: string
  lastCheckedAt: string
}

export async function bootstrapProject(worktree: string, input?: { pluginRoot?: string }): Promise<BootstrapStatus> {
  const indexDir = resolve(worktree, ".index")
  const configPath = resolve(indexDir, "indexing.config.json")
  const gitignorePath = resolve(indexDir, ".gitignore")
  const installMarkerPath = resolve(indexDir, "openindex.install.json")

  const createdIndexDir = !(await exists(indexDir))
  await mkdir(indexDir, { recursive: true })

  const createdGitignore = await writeIfMissing(gitignorePath, "*\n!.gitignore\n")
  const createdConfig = await ensureProjectConfigFile(worktree, configPath)
  const createdInstallMarker = await ensureInstallMarker(installMarkerPath)
  const skillTargetDirs = input?.pluginRoot ? await resolveBundledSkillTargetDirs(worktree, input.pluginRoot) : []
  const skill = input?.pluginRoot
    ? await copyBundledSkill(input.pluginRoot, { targetDirs: skillTargetDirs })
    : { sourceDir: "", targetDirs: [] as string[], installedDirs: [] as string[] }

  const config = await loadConfig(worktree)
  const key = await resolveGoogleApiKey(config)

  return {
    indexDir,
    configPath,
    gitignorePath,
    installMarkerPath,
    createdIndexDir,
    createdConfig,
    createdGitignore,
    createdInstallMarker,
    apiKeySource: key.source,
    apiKeyLocation: key.location,
    skillSourceDir: skill.sourceDir,
    skillTargetDirs: skill.targetDirs,
    installedSkillDirs: skill.installedDirs,
    ready: key.source !== "missing",
  }
}

export async function resolveGoogleApiKey(config: IndexingConfig): Promise<ApiKeyResolution> {
  const envName = config.googleApiKeyEnv || DEFAULT_CONFIG.googleApiKeyEnv
  const fromEnv = process.env[envName]
  if (fromEnv?.trim()) {
    return { apiKey: fromEnv.trim(), source: "env", location: envName }
  }

  if (config.googleApiKeyFile?.trim()) {
    const keyPath = expandHome(config.googleApiKeyFile.trim())
    try {
      const fromFile = await readFile(keyPath, "utf8")
      if (fromFile.trim()) {
        return { apiKey: fromFile.trim(), source: "file", location: keyPath }
      }
    } catch {
      // Missing/unreadable key files are treated as not configured.
    }
  }

  if (config.googleApiKey?.trim()) {
    return { apiKey: config.googleApiKey.trim(), source: "config", location: ".index/indexing.config.json" }
  }

  return { apiKey: "", source: "missing", location: "" }
}

export function defaultGoogleApiKeyFile(): string {
  return resolve(homedir(), ".config", "opencode", "openindex", "google_api_key")
}

export async function saveGoogleApiKeyFile(apiKey: string, input?: { targetPath?: string }): Promise<string> {
  const targetPath = input?.targetPath ? expandHome(input.targetPath) : defaultGoogleApiKeyFile()
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, `${apiKey.trim()}\n`, { encoding: "utf8", mode: 0o600 })
  return targetPath
}

export async function setProjectGoogleApiKeyFile(worktree: string, keyPath: string): Promise<void> {
  const configPath = resolve(worktree, ".index", "indexing.config.json")
  await ensureProjectConfigFile(worktree, configPath)

  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Cannot update invalid OpenIndex config at ${configPath}: ${String((error as { message?: string })?.message ?? error)}`)
  }

  parsed.googleApiKeyFile = keyPath
  parsed.googleApiKeyEnv = typeof parsed.googleApiKeyEnv === "string" ? parsed.googleApiKeyEnv : DEFAULT_CONFIG.googleApiKeyEnv
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
}

export async function copyBundledSkill(
  projectRoot: string,
  input?: { targetDirs?: string[] },
): Promise<{ sourceDir: string; targetDirs: string[]; installedDirs: string[] }> {
  const sourceDir = resolve(projectRoot, "skills", "index-tool")
  const targetDirs = input?.targetDirs ?? [
    resolve(homedir(), ".config", "opencode", "skills", "index-tool"),
    resolve(homedir(), ".agents", "skills", "index-tool"),
  ]
  const installedDirs: string[] = []

  if (!(await exists(sourceDir))) return { sourceDir, targetDirs, installedDirs }

  for (const targetDir of targetDirs) {
    if (await exists(targetDir)) continue
    await mkdir(dirname(targetDir), { recursive: true })
    await cp(sourceDir, targetDir, { recursive: true })
    installedDirs.push(targetDir)
  }

  return { sourceDir, targetDirs, installedDirs }
}

export async function resolveBundledSkillTargetDirs(worktree: string, pluginRoot: string): Promise<string[]> {
  if (await isProjectScopedPlugin(worktree, pluginRoot)) {
    return [resolve(worktree, ".opencode", "skills", "index-tool")]
  }

  return [resolve(homedir(), ".config", "opencode", "skills", "index-tool")]
}

async function isProjectScopedPlugin(worktree: string, pluginRoot: string): Promise<boolean> {
  const projectConfigPaths = [
    resolve(worktree, "opencode.json"),
    resolve(worktree, "opencode.jsonc"),
    resolve(worktree, ".opencode", "opencode.json"),
    resolve(worktree, ".opencode", "opencode.jsonc"),
  ]
  const normalizedPluginRoot = normalizePath(pluginRoot)

  if (normalizedPluginRoot.startsWith(`${normalizePath(resolve(worktree, ".opencode"))}/`)) {
    return true
  }

  for (const configPath of projectConfigPaths) {
    try {
      const raw = (await readFile(configPath, "utf8")).toLowerCase()
      const normalizedRaw = raw.replace(/\\\\/g, "/").replace(/\\/g, "/")
      if (raw.includes(PLUGIN_NAME) || normalizedRaw.includes(normalizedPluginRoot)) {
        return true
      }
    } catch {
      // Missing project config files mean this workspace did not declare the plugin locally.
    }
  }

  return false
}

async function ensureInstallMarker(path: string): Promise<boolean> {
  const now = new Date().toISOString()
  let installedAt = now
  let existed = false

  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<InstallMarker>
    installedAt = typeof parsed.installedAt === "string" ? parsed.installedAt : now
    existed = true
  } catch {
    existed = false
  }

  const marker: InstallMarker = {
    plugin: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    schemaVersion: INSTALL_SCHEMA_VERSION,
    installedAt,
    lastCheckedAt: now,
  }

  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8")
  return !existed
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  if (await exists(path)) return false
  await writeFile(path, content, "utf8")
  return true
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(path)
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\\/g, "/").toLowerCase()
}
