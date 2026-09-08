@echo off
chcp 65001 >nul
echo ============================================
echo  清理右键菜单 - 需要管理员权限运行
echo ============================================
echo.

echo [1/4] 删除 360 sfsysmenu 右键扩展（文件瘦身/批量打印/批量重命名）...
reg delete "HKLM\SOFTWARE\Classes\*\shellex\ContextMenuHandlers\sfsysmenu" /f 2>nul
reg delete "HKLM\SOFTWARE\Classes\Directory\shellex\ContextMenuHandlers\sfsysmenu" /f 2>nul
reg delete "HKLM\SOFTWARE\Classes\Folder\ShellEx\ContextMenuHandlers\sfsysmenu" /f 2>nul
reg delete "HKLM\SOFTWARE\Classes\lnkfile\shellex\ContextMenuHandlers\sfsysmenu" /f 2>nul

echo [2/4] 验证之前的删除是否生效（Git GUI/Bash、ToDesk、VS、ZCode）...
reg query "HKLM\SOFTWARE\Classes\Directory\shell" 2>nul | findstr /i "git_gui git_shell ToDesk AnyCode"
reg query "HKCU\Software\Classes\Directory\shell" 2>nul | findstr /i "ZCode"
reg query "HKCU\Software\Classes\Drive\shell" 2>nul | findstr /i "ZCode"
echo   （上面无输出 = 已删干净）

echo [3/4] 重启资源管理器使改动生效...
taskkill /f /im explorer.exe >nul 2>&1
start explorer.exe

echo.
echo [4/4] 完成！
echo.
echo 说明：如果菜单里还有 "Open project in ChatGPT"，
echo 它来自 ChatGPT UWP 应用自身的集成，无法通过注册表删除，
echo 需要在 ChatGPT 应用设置里关闭，或卸载该应用。
echo.
pause
