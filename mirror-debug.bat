@echo off
REM Double-click to keep debug\chrome, debug\firefox and debug\electron in sync with
REM the working tree. Leave this window open while developing; Ctrl+C to stop.
cd /d "%~dp0"

node scripts\mirror-debug.js --watch

echo.
echo Mirror stopped.
pause
