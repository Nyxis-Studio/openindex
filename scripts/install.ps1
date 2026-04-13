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
  "description: Executa indexacao local via plugin",
  "---",
  "Execute a indexacao local padronizada.",
  "",
  $shellLine,
  "",
  "Responda somente: Indexacao concluida."
) | Set-Content -Path $commandFile -Encoding UTF8

@(
  "---",
  "description: Mostra status da indexacao de embeddings",
  "---",
  "Mostre o status atual da indexacao local.",
  "",
  $statusShellLine
) | Set-Content -Path $statusCommandFile -Encoding UTF8

@(
  "---",
  "description: Testa busca semantica nos embeddings locais",
  "---",
  "Use os argumentos como consulta semantica e rode teste:",
  "",
  $testShellLine
) | Set-Content -Path $testCommandFile -Encoding UTF8

if ($GoogleApiKey -and $GoogleApiKey.Trim().Length -gt 0) {
  setx GOOGLE_API_KEY "$GoogleApiKey" | Out-Null
  Write-Host "GOOGLE_API_KEY configurada com sucesso (abra novo terminal/OpenCode)." -ForegroundColor Green
}

Write-Host "Plugin instalado em: $targetRoot" -ForegroundColor Green
Write-Host "Comando global instalado em: $commandFile" -ForegroundColor Green
Write-Host "Comando de status instalado em: $statusCommandFile" -ForegroundColor Green
Write-Host "Comando de teste instalado em: $testCommandFile" -ForegroundColor Green
Write-Host "Reinicie o OpenCode e use /embedding" -ForegroundColor Yellow
