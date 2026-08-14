# 清理 Windows 图标缓存（重启 explorer.exe，会短暂关闭资源管理器窗口）。
# 旧版脚本在 SilentlyContinue 下不校验删除结果，文件被占用时"假装成功"，
# 导致陈旧图标缓存残留、图标问题反复出现。本版逐个校验并重试。
$ErrorActionPreference = "Stop"

$targets = @(
  (Join-Path $env:LOCALAPPDATA "IconCache.db"),
  (Join-Path $env:ProgramData "Microsoft\Windows\IconCache")
)
$explorerDir = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Explorer"

Write-Host "Stopping explorer.exe ..."
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$cacheFiles = Get-ChildItem -Path $explorerDir -Filter "iconcache_*.db" -ErrorAction SilentlyContinue
foreach ($file in $cacheFiles) { $targets += $file.FullName }

$removed = 0
$failed = @()
foreach ($path in $targets) {
  if (-not (Test-Path $path)) { continue }
  $ok = $false
  for ($attempt = 1; $attempt -le 4 -and -not $ok; $attempt++) {
    try {
      Remove-Item $path -Recurse -Force -ErrorAction Stop
      if (-not (Test-Path $path)) { $ok = $true }
    } catch {
      Start-Sleep -Milliseconds 800
    }
  }
  if ($ok) {
    Write-Host "Removed: $path"
    $removed++
  } else {
    Write-Host "FAILED (still locked): $path"
    $failed += $path
  }
}

Write-Host "Starting explorer.exe ..."
Start-Process explorer.exe
Write-Host ("Done: removed {0}, failed {1}." -f $removed, $failed.Count)
if ($failed.Count -gt 0) { exit 1 }
