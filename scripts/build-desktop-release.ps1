$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $workspace "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
$releaseDir = Join-Path $workspace "release\v$version"
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$stagingDir = [System.IO.Path]::GetFullPath((Join-Path $tempRoot "hpp-desktop-$version-$PID"))
$electronDist = [System.IO.Path]::GetFullPath((Join-Path $workspace "node_modules\electron\dist"))

if (-not $stagingDir.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Desktop staging directory must remain under $tempRoot"
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $electronDist "electron.exe"))) {
  throw "Installed Electron runtime was not found at $electronDist"
}

try {
  & npx electron-builder "--config.directories.output=$stagingDir" "--config.electronDist=$electronDist"
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
} finally {
  if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
  }
}

Write-Output "Desktop release artifacts copied to $releaseDir"
