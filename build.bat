@echo off

REM Create MV2 background script
echo Creating MV2 background script...
powershell -Command "(Get-Content background.js | Select-Object -Skip 2) | Set-Content background_mv2.js"

REM Chrome build
echo Starting Chrome build...
if exist manifest_chrome.json (
    copy manifest_chrome.json manifest.json
    call web-ext build --filename "{name}-{version}-chrome.zip" -o
    del manifest.json
    echo Chrome build complete.
)

REM Firefox build
echo Starting Firefox build...
if exist manifest_firefox.json (
    copy manifest_firefox.json manifest.json    
    call web-ext build --filename "{name}-{version}-firefox.zip" -o
    del manifest.json
    echo Firefox build complete.
)

REM Electron build
echo Starting Electron build...
if exist manifest_electron.json (
    copy manifest_electron.json manifest.json    
    call web-ext build --filename "{name}-{version}-electron.zip" -o
    del manifest.json
    echo Electron build complete.
)

REM Clean up
del background_mv2.js
echo All builds completed.