@echo off
cd /d "%~dp0"
title AnTerm

echo.
echo   AnTerm - starting up
echo   ===================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Get the LTS from https://nodejs.org  then run this again.
  pause & exit /b 1
)

if not exist "node_modules\" (
  echo   Installing dependencies ^(first run, a few minutes^)...
  call npm install --no-fund --no-audit
  if errorlevel 1 ( echo   npm install failed - see above. & pause & exit /b 1 )
)

rem native module sanity check - rebuild if the prebuilt binary never got fetched
node -e "new (require('better-sqlite3'))(':memory:')" >nul 2>nul
if errorlevel 1 (
  echo   Building native modules...
  call npm rebuild better-sqlite3 argon2 ssh2 --foreground-scripts
  node -e "new (require('better-sqlite3'))(':memory:')" >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   better-sqlite3 still won't load. Use Node 22 LTS ^(nvm-windows^), or install
    echo   Visual Studio Build Tools with the "Desktop development with C++" workload.
    pause & exit /b 1
  )
)

if not exist "server\dist\index.js" (
  echo   Building the app...
  call npm run build
  if errorlevel 1 ( echo   build failed - see above. & pause & exit /b 1 )
)

if not exist ".env" (
  echo.
  echo   No .env file yet. Create one here ^(C:\...\anterm\.env^) with at least:
  echo.
  echo       ANTERM_APP_SECRET=some-long-random-string-32-chars-or-more
  echo       ADMIN_USER=admin
  echo       ADMIN_PASSWORD=pick-a-password
  echo.
  echo   Then run this again.
  pause & exit /b 1
)

echo.
echo   Open  http://localhost:3000  in a browser on this machine.
echo   Admin login is ADMIN_USER / ADMIN_PASSWORD from the .env file.
echo   Press Ctrl+C here to stop.
echo.
node --env-file=.env server\dist\index.js
echo.
echo   AnTerm stopped.
pause
