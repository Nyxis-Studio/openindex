param(
  [string]$GoogleApiKey
)

$ErrorActionPreference = "Stop"

$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$targetRoot = Join-Path $env:USERPROFILE ".config\opencode\plugins\embedding-cache-plugin"
$commandsDir = Join-Path $env:USERPROFILE ".config\opencode\commands"
$commandFile = Join-Path $commandsDir "embedding.md"
$statusCommandFile = Join-Path $commandsDir "embedding-status.md"
$testCommandFile = Join-Path $commandsDir "embedding-test.md"

if (Test-Path $targetRoot) {
  Remove-Item -Recurse -Force $targetRoot
}

New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null

Copy-Item (Join-Path $sourceRoot "package.json") $targetRoot -Force
Copy-Item (Join-Path $sourceRoot "src") (Join-Path $targetRoot "src") -Recurse -Force
if (Test-Path (Join-Path $sourceRoot "README.md")) {
  Copy-Item (Join-Path $sourceRoot "README.md") $targetRoot -Force
}

npm --prefix "$targetRoot" install --omit=dev | Out-Null

New-Item -ItemType Directory -Path $commandsDir -Force | Out-Null

$cliPath = ($targetRoot -replace "\\", "/") + "/src/cli.ts"
$shellLine = '!`bun "' + $cliPath + '"`'

$statusShellLine = '!`bun "' + $cliPath + '" status`'
$testShellLine = '!`bun "' + $cliPath + '" test "$ARGUMENTS"`'

@(
  "---",
  "description: Runs local indexing via plugin",
  "---",
  "Run standard local indexing.",
  "",
  $shellLine,
  "",
  "Reply only with: Indexing completed."
) | Set-Content -Path $commandFile -Encoding UTF8

@(
  "---",
  "description: Shows embedding indexing status",
  "---",
  "Show the current local indexing status.",
  "",
  $statusShellLine
) | Set-Content -Path $statusCommandFile -Encoding UTF8

@(
  "---",
  "description: Tests semantic search on local embeddings",
  "---",
  "Use arguments as a semantic query and run test:",
  "",
  $testShellLine
) | Set-Content -Path $testCommandFile -Encoding UTF8

if ($GoogleApiKey -and $GoogleApiKey.Trim().Length -gt 0) {
  setx GOOGLE_API_KEY "$GoogleApiKey" | Out-Null
  Write-Host "GOOGLE_API_KEY configured successfully (open a new terminal/OpenCode session)." -ForegroundColor Green
}

Write-Host "Plugin installed at: $targetRoot" -ForegroundColor Green
Write-Host "Global command installed at: $commandFile" -ForegroundColor Green
Write-Host "Status command installed at: $statusCommandFile" -ForegroundColor Green
Write-Host "Test command installed at: $testCommandFile" -ForegroundColor Green
Write-Host "Restart OpenCode and use /embedding" -ForegroundColor Yellow
