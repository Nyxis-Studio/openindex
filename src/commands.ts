export const OPENINDEX_COMMANDS = {
  embedding: {
    description: "Index the current project with OpenIndex",
    template: "Run OpenIndex local code embedding indexing.",
  },
  "embedding-status": {
    description: "Show OpenIndex indexing status",
    template: "Show OpenIndex local indexing status.",
  },
  "embedding-test": {
    description: "Test OpenIndex semantic retrieval with a query",
    template: "Run OpenIndex semantic retrieval test for: $ARGUMENTS",
  },
  "embedding-setup": {
    description: "Show OpenIndex Google API key setup instructions",
    template: "Show OpenIndex setup instructions for configuring the Google API key.",
  },
} as const

export type OpenIndexCommandName = keyof typeof OPENINDEX_COMMANDS

export function isOpenIndexCommand(command: string): command is OpenIndexCommandName {
  return command in OPENINDEX_COMMANDS
}

export function applyOpenIndexConfig(config: {
  command?: Record<string, unknown>
  skills?: { paths?: string[]; urls?: string[] }
}, input?: { skillPath?: string }): void {
  config.command ??= {}
  for (const [name, definition] of Object.entries(OPENINDEX_COMMANDS)) {
    config.command[name] ??= definition
  }

  if (input?.skillPath) {
    config.skills ??= {}
    config.skills.paths ??= []
    if (!config.skills.paths.includes(input.skillPath)) {
      config.skills.paths.push(input.skillPath)
    }
  }
}
