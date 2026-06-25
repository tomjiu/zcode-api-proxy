@echo off
chcp 65001 >nul
title ZCode Proxy Server
echo.
echo ==== ZCode Proxy Server ====
echo.
echo [1/2] Killing old process on port 8081...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8081"') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo   Port 8081 cleared.
echo.
echo [2/2] Starting server...
echo.
bun run src/index.ts serve
pause
