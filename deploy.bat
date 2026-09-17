@echo off
setlocal EnableDelayedExpansion

:: ============================================================
:: Richman game - one-click upload & deploy (double-click to run)
:: Flow: git init (first time) -> add -> commit -> push,
::        then optional SSH server pull/build/restart.
:: Put this .bat inside the richman-main folder and double-click.
:: Edit the config vars below before first use.
:: ============================================================

set "REMOTE_URL=https://github.com/MXYZYP/richman.git"
set "BRANCH=main"

set "SERVER_DEPLOY=0"
set "SERVER_HOST=root@101.200.189.252"
set "SERVER_DIR=/root/richman-main"
set "PM2_NAME=richman"

where git >nul 2>nul || (echo [ERROR] git not found. Install Git for Windows with PATH. & pause & exit /b 1)

cd /d "%~dp0" || (echo [ERROR] cannot enter repo dir & pause & exit /b 1)

if not exist ".git" (
    echo [INIT] Not a git repo, run git init ...
    git init
    git branch -M %BRANCH%
    if not "%REMOTE_URL%"=="" (
        git remote add origin %REMOTE_URL%
        echo [INIT] remote set: %REMOTE_URL%
    ) else (
        echo [NOTE] REMOTE_URL empty, local commit only, no push.
    )
)

git remote get-url origin >nul 2>&1 && (
    git pull --rebase --autostash origin %BRANCH% 2>nul
)

git add -A

git diff --quiet --cached && (
    echo [INFO] No changes to commit.
    goto :push
)

for /f "tokens=*" %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmmss"') do set "TS=%%a"
set "MSG=deploy: auto %TS%"
git commit -m "%MSG%"
echo [COMMIT] %MSG%

:push
git remote get-url origin >nul 2>&1 && (
    echo [PUSH] pushing to origin/%BRANCH% ...
    git push -u origin %BRANCH%
    if errorlevel 1 (
        echo [WARN] push rejected. If remote is non-empty, run once: git pull --rebase origin %BRANCH%
    )
) || (
    echo [SKIP] no remote set, local commit only.
)

if "%SERVER_DEPLOY%"=="1" (
    echo [DEPLOY] SSH to server: git pull + build + pm2 restart ...
    ssh %SERVER_HOST% "cd %SERVER_DIR% && git pull && pnpm --filter @richman/client build && pm2 restart %PM2_NAME%"
    if errorlevel 1 (
        echo [WARN] server deploy failed. Check SSH key and server dir.
    ) else (
        echo [DEPLOY] server updated and restarted.
    )
)

echo.
echo ===== DONE =====
pause
