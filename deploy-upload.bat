@echo off
setlocal EnableDelayedExpansion

:: ============================================================
:: Richman - manual upload (NO git repo). Double-click to run.
:: Uploads changed client source files via scp, then SSH builds
:: and restarts pm2 on the server.
:: Local machine has no node_modules, so the build runs on server.
:: Requires: Git for Windows installed (adds scp + ssh to PATH)
::           and SSH key (or password) for SERVER_HOST.
:: ============================================================

set "SERVER_HOST=root@101.200.189.252"
set "SERVER_DIR=/root/richman-main"
set "PM2_NAME=richman"

:: Local repo root is auto-detected from this .bat's location.
set "LOCAL_DIR=%~dp0"

where scp >nul 2>nul || (echo [ERROR] scp not found. Install Git for Windows (select "add to PATH"). & pause & exit /b 1)

echo [UPLOAD] sending changed client source files to server ...
scp "%LOCAL_DIR%apps\client\src\components\GameBoard.vue" %SERVER_HOST%:%SERVER_DIR%/apps/client/src/components/GameBoard.vue
scp "%LOCAL_DIR%apps\client\src\views\GameView.vue"      %SERVER_HOST%:%SERVER_DIR%/apps/client/src/views/GameView.vue
scp "%LOCAL_DIR%apps\client\src\views\HomeView.vue"      %SERVER_HOST%:%SERVER_DIR%/apps/client/src/views/HomeView.vue
scp "%LOCAL_DIR%apps\client\src\style.css"               %SERVER_HOST%:%SERVER_DIR%/apps/client/src/style.css
scp "%LOCAL_DIR%apps\client\index.html"                 %SERVER_HOST%:%SERVER_DIR%/apps/client/index.html

echo [DEPLOY] SSH into server: build + pm2 restart ...
ssh %SERVER_HOST% "cd %SERVER_DIR% && pnpm --filter @richman/client build && pm2 restart %PM2_NAME%"
if errorlevel 1 (
    echo [WARN] server build/restart failed. Check SSH key and SERVER_DIR.
) else (
    echo [OK] server rebuilt and restarted.
)

echo.
echo ===== DONE =====
pause
