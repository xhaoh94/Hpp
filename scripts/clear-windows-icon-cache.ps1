# 清理 Windows 图标缓存（重启 explorer.exe，会短暂关闭资源管理器窗口）
$ErrorActionPreference = "SilentlyContinue"

$paths = @(
  (Join-Path $env:LOCALAPPDATA "IconCache.db"),
  (Join-Path $env:ProgramData "Microsoft\Windows\IconCache")
)
$explorerDir = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Explorer"

Write-Host "Stopping explorer.exe ..."
Stop-Process -Name explorer -Force
Start-Sleep -Milliseconds 800

$removed = 0
foreach ($p in $paths) {
  if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "Removed: $p"; $removed++ }
}
$files = Get-ChildItem -Path $explorerDir -Filter "iconcache_*.db" -ErrorAction SilentlyContinue
foreach ($f in $files) { Remove-Item $f.FullName -Force; Write-Host "Removed: $($f.FullName)"; $removed++ }

Start-Sleep -Milliseconds 500
Write-Host "Starting explorer.exe ..."
Start-Process explorer.exe
Write-Host ("Done, removed {0} icon cache entries." -f $removed)
