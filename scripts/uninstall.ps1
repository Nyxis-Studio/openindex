$ErrorActionPreference = "Stop"

$targetRoot = Join-Path $env:USERPROFILE ".config\opencode\plugins\embedding-cache-plugin"
$commandFile = Join-Path $env:USERPROFILE ".config\opencode\commands\embedding.md"
$statusCommandFile = Join-Path $env:USERPROFILE ".config\opencode\commands\embedding-status.md"
$testCommandFile = Join-Path $env:USERPROFILE ".config\opencode\commands\embedding-test.md"

if (Test-Path $targetRoot) {
  Remove-Item -Recurse -Force $targetRoot
  Write-Host "Plugin removido de: $targetRoot" -ForegroundColor Green
} else {
  Write-Host "Plugin nao encontrado em: $targetRoot" -ForegroundColor Yellow
}

if (Test-Path $commandFile) {
  Remove-Item -Force $commandFile
  Write-Host "Comando global removido: $commandFile" -ForegroundColor Green
}

if (Test-Path $statusCommandFile) {
  Remove-Item -Force $statusCommandFile
  Write-Host "Comando de status removido: $statusCommandFile" -ForegroundColor Green
}

if (Test-Path $testCommandFile) {
  Remove-Item -Force $testCommandFile
  Write-Host "Comando de teste removido: $testCommandFile" -ForegroundColor Green
}
