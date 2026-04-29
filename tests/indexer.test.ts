import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { chunkTextByLines } from "../src/indexer/chunker"
import { loadConfig } from "../src/indexer/config"
import { getProjectVectorStore } from "../src/indexer/vector-store"
import {
  bootstrapProject,
  copyBundledSkill,
  resolveBundledSkillTargetDirs,
  resolveGoogleApiKey,
  saveGoogleApiKeyFile,
  setProjectGoogleApiKeyFile,
} from "../src/indexer/bootstrap"
import { applyOpenIndexConfig } from "../src/commands"

test("loadConfig does not create project config unless requested", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "openindex-config-"))
  try {
    const config = await loadConfig(dir)
    assert.equal(config.googleEmbeddingMode, "sync")
    await assert.rejects(stat(resolve(dir, ".index", "indexing.config.json")))

    await loadConfig(dir, { ensureFile: true })
    const created = await readFile(resolve(dir, ".index", "indexing.config.json"), "utf8")
    assert.match(created, /googleEmbeddingMode/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("chunkTextByLines splits oversized single lines", () => {
  const chunks = chunkTextByLines({
    text: "a".repeat(40),
    chunkSizeBytes: 10,
    overlapLines: 0,
    maxChunks: 10,
  })

  assert.equal(chunks.length, 4)
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk.text, "utf8") <= 10))
})

test("vector store cache is separated by manifest path", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "openindex-store-"))
  try {
    const first = await getProjectVectorStore(dir, ".index/one.json")
    const second = await getProjectVectorStore(dir, ".index/two.json")
    assert.notEqual(first, second)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("bootstrap creates project files and is idempotent", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "openindex-bootstrap-"))
  const previous = process.env.GOOGLE_API_KEY
  try {
    delete process.env.GOOGLE_API_KEY
    const first = await bootstrapProject(dir)
    assert.equal(first.createdIndexDir, true)
    assert.equal(first.createdConfig, true)
    assert.equal(first.createdGitignore, true)
    assert.equal(first.createdInstallMarker, true)
    assert.equal(first.ready, false)
    assert.equal(first.apiKeySource, "missing")

    assert.match(await readFile(resolve(dir, ".index", ".gitignore"), "utf8"), /\*/)
    assert.match(await readFile(resolve(dir, ".index", "indexing.config.json"), "utf8"), /googleApiKeyEnv/)
    assert.match(await readFile(resolve(dir, ".index", "openindex.install.json"), "utf8"), /@nyxis-studio\/openindex/)

    const second = await bootstrapProject(dir)
    assert.equal(second.createdConfig, false)
    assert.equal(second.createdGitignore, false)
    assert.equal(second.createdInstallMarker, false)
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_API_KEY
    else process.env.GOOGLE_API_KEY = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test("bootstrap preserves existing project config", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "openindex-bootstrap-config-"))
  const previous = process.env.GOOGLE_API_KEY
  try {
    delete process.env.GOOGLE_API_KEY
    await writeFile(resolve(dir, ".index-placeholder"), "", "utf8")
    await bootstrapProject(dir)
    const configPath = resolve(dir, ".index", "indexing.config.json")
    await writeFile(configPath, '{"autoIndexOnStartup":false,"googleApiKey":"from-config"}\n', "utf8")

    const status = await bootstrapProject(dir)
    assert.equal(status.createdConfig, false)
    assert.equal(status.ready, true)
    assert.equal(status.apiKeySource, "config")
    assert.match(await readFile(configPath, "utf8"), /from-config/)
    assert.match(await readFile(configPath, "utf8"), /autoIndexOnStartup":false/)
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_API_KEY
    else process.env.GOOGLE_API_KEY = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test("resolveGoogleApiKey priority is env then file then config", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "openindex-key-"))
  const previous = process.env.OPENINDEX_TEST_GOOGLE_KEY
  try {
    const keyFile = resolve(dir, "google-key.txt")
    await writeFile(keyFile, "from-file\n", "utf8")
    const base = {
      ...(await loadConfig(dir)),
      googleApiKeyEnv: "OPENINDEX_TEST_GOOGLE_KEY",
      googleApiKeyFile: keyFile,
      googleApiKey: "from-config",
    }

    delete process.env.OPENINDEX_TEST_GOOGLE_KEY
    const fromFile = await resolveGoogleApiKey(base)
    assert.equal(fromFile.source, "file")
    assert.equal(fromFile.apiKey, "from-file")

    process.env.OPENINDEX_TEST_GOOGLE_KEY = "from-env"
    const fromEnv = await resolveGoogleApiKey(base)
    assert.equal(fromEnv.source, "env")
    assert.equal(fromEnv.apiKey, "from-env")

    delete process.env.OPENINDEX_TEST_GOOGLE_KEY
    const fromConfig = await resolveGoogleApiKey({ ...base, googleApiKeyFile: resolve(dir, "missing.txt") })
    assert.equal(fromConfig.source, "config")
    assert.equal(fromConfig.apiKey, "from-config")
  } finally {
    if (previous === undefined) delete process.env.OPENINDEX_TEST_GOOGLE_KEY
    else process.env.OPENINDEX_TEST_GOOGLE_KEY = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test("setup stores key in file and links project config", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "openindex-setup-"))
  const previous = process.env.GOOGLE_API_KEY
  try {
    delete process.env.GOOGLE_API_KEY
    const keyFile = resolve(dir, "secret", "google_api_key")
    const storedPath = await saveGoogleApiKeyFile("stored-key", { targetPath: keyFile })
    await setProjectGoogleApiKeyFile(dir, storedPath)

    const config = await loadConfig(dir)
    const resolved = await resolveGoogleApiKey(config)
    assert.equal(config.googleApiKeyFile, storedPath)
    assert.equal(resolved.source, "file")
    assert.equal(resolved.apiKey, "stored-key")
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_API_KEY
    else process.env.GOOGLE_API_KEY = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test("copyBundledSkill installs skill without overwriting existing targets", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "openindex-skill-"))
  try {
    const source = resolve(dir, "plugin", "skills", "index-tool")
    const firstTarget = resolve(dir, "config", "opencode", "skills", "index-tool")
    const secondTarget = resolve(dir, "agents", "skills", "index-tool")
    await mkdir(source, { recursive: true })
    await mkdir(firstTarget, { recursive: true })
    await writeFile(resolve(source, "SKILL.md"), "---\nname: index-tool\ndescription: test\n---\n", "utf8")
    await writeFile(resolve(firstTarget, "SKILL.md"), "existing", "utf8")

    const result = await copyBundledSkill(resolve(dir, "plugin"), { targetDirs: [firstTarget, secondTarget] })
    assert.deepEqual(result.installedDirs, [secondTarget])
    assert.equal(await readFile(resolve(firstTarget, "SKILL.md"), "utf8"), "existing")
    assert.match(await readFile(resolve(secondTarget, "SKILL.md"), "utf8"), /index-tool/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("resolveBundledSkillTargetDirs uses project skill folder for project plugin config", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "openindex-skill-scope-project-"))
  try {
    const pluginRoot = resolve(dir, "plugin")
    await writeFile(resolve(dir, "opencode.json"), JSON.stringify({ plugin: [pluginRoot] }), "utf8")

    const targets = await resolveBundledSkillTargetDirs(dir, pluginRoot)
    assert.deepEqual(targets, [resolve(dir, ".opencode", "skills", "index-tool")])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("resolveBundledSkillTargetDirs uses global skill folder when project did not declare plugin", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "openindex-skill-scope-global-"))
  try {
    const pluginRoot = resolve(dir, "plugin")
    const targets = await resolveBundledSkillTargetDirs(dir, pluginRoot)
    assert.equal(targets.length, 1)
    assert.match(targets[0].replace(/\\/g, "/"), /\.config\/opencode\/skills\/index-tool$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("applyOpenIndexConfig injects commands and skill path without overwriting user commands", () => {
  const config: {
    command: Record<string, unknown>
    skills?: { paths?: string[] }
  } = {
    command: {
      embedding: {
        template: "custom",
      },
    },
  }

  applyOpenIndexConfig(config, { skillPath: "/plugin/skills/index-tool" })
  assert.deepEqual(config.command.embedding, { template: "custom" })
  assert.ok(config.command["embedding-status"])
  assert.ok(config.command["embedding-test"])
  assert.ok(config.command["embedding-setup"])
  assert.deepEqual(config.skills?.paths, ["/plugin/skills/index-tool"])

  applyOpenIndexConfig(config, { skillPath: "/plugin/skills/index-tool" })
  assert.deepEqual(config.skills?.paths, ["/plugin/skills/index-tool"])
})
