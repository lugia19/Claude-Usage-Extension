@echo off

REM Not part of the extension: the debug mirrors, dev scripts, the common submodule's tooling and docs,
REM and the Photoshop sources of the icons and store images.
set IGNORE="debug/**" "scripts/**" ".github/**" "common/scripts/**" "common/README.md" "**/*.psd"

REM Stop unless common/ is exactly the pinned commit, and that matches common's main. The check
REM lives in the submodule, so check it out first if it never was (only then: never undo a checkout).
if not exist common\.git git submodule update --init common
node common/scripts/check-common.js || exit /b 1

REM Build dataclasses
echo Building dataclasses...
node scripts/build-dataclasses.js

REM Chrome build
echo Starting Chrome build...
if exist manifest_chrome.json (
    copy manifest_chrome.json manifest.json
    call web-ext build --filename "{name}-{version}-chrome.zip" -o --ignore-files %IGNORE%
    del manifest.json
    echo Chrome build complete.
)

REM Firefox build
echo Starting Firefox build...
if exist manifest_firefox.json (
    copy manifest_firefox.json manifest.json    
    call web-ext build --filename "{name}-{version}-firefox.zip" -o --ignore-files %IGNORE%
    del manifest.json
    echo Firefox build complete.
)

REM Electron build
echo Starting Electron build...
if exist manifest_electron.json (
    copy manifest_electron.json manifest.json    
    call web-ext build --filename "{name}-{version}-electron.zip" -o --ignore-files %IGNORE%
    del manifest.json
    echo Electron build complete.
)

REM Clean up
echo All builds completed.