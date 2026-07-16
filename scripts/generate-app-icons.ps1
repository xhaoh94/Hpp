$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $workspace "design\app-icon"
$renderDir = Join-Path $env:TEMP "hpp-icon-render-$PID"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) {
  $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $edge)) {
  throw "Microsoft Edge is required to render the SVG icon sources."
}

New-Item -ItemType Directory -Force -Path $renderDir | Out-Null

function Render-Svg([string]$sourceName, [string]$outputName) {
  $sourcePath = (Resolve-Path (Join-Path $sourceDir $sourceName)).Path.Replace("\", "/")
  $outputPath = Join-Path $renderDir $outputName
  $profilePath = Join-Path $renderDir "edge-$outputName"
  $arguments = @(
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1024,1024",
    "--default-background-color=00000000",
    "--run-all-compositor-stages-before-draw",
    "--user-data-dir=$profilePath",
    "--screenshot=$outputPath",
    "file:///$sourcePath"
  )
  $process = Start-Process $edge -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0 -or -not (Test-Path $outputPath)) {
    throw "Unable to render $sourceName"
  }
  return $outputPath
}

Add-Type -AssemblyName System.Drawing

function Resize-Png([string]$sourcePath, [string]$outputPath, [int]$size) {
  $source = [System.Drawing.Bitmap]::FromFile($sourcePath)
  $target = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($target)
  try {
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($source, 0, 0, $size, $size)
    $target.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $target.Dispose()
    $source.Dispose()
  }
}

$squareMaster = Render-Svg "hpp-icon.svg" "square.png"
$roundMaster = Render-Svg "hpp-icon-round.svg" "round.png"
$foregroundMaster = Render-Svg "hpp-icon-foreground.svg" "foreground.png"

Copy-Item -Force $squareMaster (Join-Path $workspace "public\icon.png")

$launcherSizes = [ordered]@{
  "mdpi" = 48
  "hdpi" = 72
  "xhdpi" = 96
  "xxhdpi" = 144
  "xxxhdpi" = 192
}
$foregroundSizes = [ordered]@{
  "mdpi" = 108
  "hdpi" = 162
  "xhdpi" = 216
  "xxhdpi" = 324
  "xxxhdpi" = 432
}
$resourceRoot = Join-Path $workspace "mobile\android\app\src\main\res"

foreach ($density in $launcherSizes.Keys) {
  $targetDir = Join-Path $resourceRoot "mipmap-$density"
  Resize-Png $squareMaster (Join-Path $targetDir "ic_launcher.png") $launcherSizes[$density]
  Resize-Png $roundMaster (Join-Path $targetDir "ic_launcher_round.png") $launcherSizes[$density]
  Resize-Png $foregroundMaster (Join-Path $targetDir "ic_launcher_foreground.png") $foregroundSizes[$density]
}

Write-Output "Generated Hpp desktop and Android icons from design/app-icon/hpp-icon.svg"
