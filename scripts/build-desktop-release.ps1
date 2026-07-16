$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $workspace "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
$releaseDir = Join-Path $workspace "release"
$stagingDir = Join-Path $releaseDir "desktop-$version-$PID"

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

& npx electron-builder "--config.directories.output=$stagingDir"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$artifacts = @(
  "hpp-Setup-$version.exe",
  "hpp-Setup-$version.exe.blockmap",
  "latest.yml"
)

foreach ($artifact in $artifacts) {
  $source = Join-Path $stagingDir $artifact
  if (-not (Test-Path $source)) {
    throw "Desktop release artifact was not produced at $source"
  }
  Copy-Item -Force $source (Join-Path $releaseDir $artifact)
}

Write-Output "Desktop release artifacts copied to $releaseDir"
