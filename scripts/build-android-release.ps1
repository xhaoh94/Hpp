$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$androidProject = Join-Path $workspace "mobile\android"
$package = Get-Content (Join-Path $workspace "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
$appGradlePath = Join-Path $androidProject "app\build.gradle"
$appGradle = Get-Content $appGradlePath -Raw
$versionCodeMatch = [regex]::Match($appGradle, '(?m)^\s*versionCode\s+(\d+)\s*$')
$versionNameMatch = [regex]::Match($appGradle, '(?m)^\s*versionName\s+"([^"]+)"\s*$')
if (-not $versionCodeMatch.Success -or -not $versionNameMatch.Success) {
  throw "Unable to read Android versionCode/versionName from $appGradlePath"
}
$versionCode = [int]$versionCodeMatch.Groups[1].Value
$androidVersion = $versionNameMatch.Groups[1].Value
if ($androidVersion -ne $version) {
  throw "Android versionName $androidVersion does not match package version $version"
}

if (-not $env:JAVA_HOME) {
  $androidStudioJbr = "C:\Program Files\Android\Android Studio\jbr"
  if (Test-Path (Join-Path $androidStudioJbr "bin\java.exe")) {
    $env:JAVA_HOME = $androidStudioJbr
  }
}

if (-not $env:ANDROID_HOME) {
  $defaultSdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
  if (Test-Path $defaultSdk) {
    $env:ANDROID_HOME = $defaultSdk
  }
}

if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
  throw "JDK not found. Install Android Studio or set JAVA_HOME before building."
}

if (-not $env:ANDROID_HOME -or -not (Test-Path $env:ANDROID_HOME)) {
  throw "Android SDK not found. Install it with Android Studio or set ANDROID_HOME."
}

& node (Join-Path $PSScriptRoot "ensure-android-signing.cjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location $androidProject
try {
  & ".\gradlew.bat" assembleRelease --no-daemon --max-workers=1 --no-build-cache
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

$sourceApk = Join-Path $androidProject "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $sourceApk)) {
  throw "Release APK was not produced at $sourceApk"
}

$buildTools = Get-ChildItem (Join-Path $env:ANDROID_HOME "build-tools") -Directory |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1
$apkSigner = Join-Path $buildTools.FullName "apksigner.bat"
if (-not (Test-Path $apkSigner)) {
  throw "apksigner was not found under $($buildTools.FullName)"
}

& $apkSigner verify --verbose --print-certs $sourceApk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$releaseDir = Join-Path $workspace "release\v$version"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$releaseApk = Join-Path $releaseDir "Hpp-Android.apk"
Copy-Item -Force $sourceApk $releaseApk

$sha256 = (Get-FileHash $releaseApk -Algorithm SHA256).Hash.ToLowerInvariant()
$metadata = [ordered]@{
  version = $version
  versionCode = $versionCode
  url = "https://github.com/xhaoh94/Hpp/releases/latest/download/Hpp-Android.apk"
  sha256 = $sha256
  publishedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$metadataJson = $metadata | ConvertTo-Json
$metadataPath = Join-Path $releaseDir "android-latest.json"
[System.IO.File]::WriteAllText($metadataPath, $metadataJson, [System.Text.UTF8Encoding]::new($false))

Write-Output "Android release APK: $releaseApk"
Write-Output "Android update metadata: $metadataPath"
Write-Output "SHA-256: $sha256"
