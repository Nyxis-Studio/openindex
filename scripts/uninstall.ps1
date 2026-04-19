$ErrorActionPreference = "Stop"

$targetRoot = Join-Path $env:USERPROFILE ".config\opencode\plugins\embedding-cache-plugin"
$commandFile = Join-Path $env:USERPROFILE ".config\opencode\commands\embedding.md"
$statusCommandFile = Join-Path $env:USERPROFILE ".config\opencode\commands\embedding-status.md"
$testCommandFile = Join-Path $env:USERPROFILE ".config\opencode\commands\embedding-test.md"
$skillTargetDir = Join-Path $env:USERPROFILE ".agents\skills\index-tool"

if (Test-Path $targetRoot) {
  Remove-Item -Recurse -Force $targetRoot
  Write-Host "Plugin removed from: $targetRoot" -ForegroundColor Green
} else {
  Write-Host "Plugin not found at: $targetRoot" -ForegroundColor Yellow
}

if (Test-Path $commandFile) {
  Remove-Item -Force $commandFile
  Write-Host "Global command removed: $commandFile" -ForegroundColor Green
}

if (Test-Path $statusCommandFile) {
  Remove-Item -Force $statusCommandFile
  Write-Host "Status command removed: $statusCommandFile" -ForegroundColor Green
}

if (Test-Path $testCommandFile) {
  Remove-Item -Force $testCommandFile
  Write-Host "Test command removed: $testCommandFile" -ForegroundColor Green
}

if (Test-Path $skillTargetDir) {
  Remove-Item -Recurse -Force $skillTargetDir
  Write-Host "Skill removed: $skillTargetDir" -ForegroundColor Green
}
