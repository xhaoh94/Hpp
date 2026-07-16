$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$androidProject = Join-Path $workspace "mobile\android"

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

Push-Location $androidProject
try {
  & ".\gradlew.bat" assembleDebug --no-daemon --max-workers=1
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
