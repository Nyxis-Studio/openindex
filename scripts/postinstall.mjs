import { cp, mkdir, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = resolve(__dirname, "..")

const skillSourceDir = resolve(projectRoot, "skills", "index-tool")
const skillTargetDirs = [resolve(homedir(), ".config", "opencode", "skills", "index-tool")]

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function installSkill() {
  const hasSource = await exists(skillSourceDir)
  if (!hasSource) {
    console.log("[openindex] Skill source not found, skipping skill install.")
    return
  }

  for (const skillTargetDir of skillTargetDirs) {
    if (await exists(skillTargetDir)) {
      console.log(`[openindex] Skill already exists, leaving it unchanged: ${skillTargetDir}`)
      continue
    }

    await mkdir(dirname(skillTargetDir), { recursive: true })
    await cp(skillSourceDir, skillTargetDir, { recursive: true })
    console.log(`[openindex] Installed skill: ${skillTargetDir}`)
  }
}

installSkill().catch((error) => {
  console.warn(`[openindex] Failed to install skill automatically: ${String(error?.message ?? error)}`)
})
