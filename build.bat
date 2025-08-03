@echo off

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
echo All builds completed.