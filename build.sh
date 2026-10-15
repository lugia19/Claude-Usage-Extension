#!/usr/bin/env bash
# Unix counterpart of build.bat. Produces the Chrome, Firefox and Electron zips
# in web-ext-artifacts/.
set -euo pipefail

# Make sure the temporary manifest.json is removed even if web-ext fails.
trap 'rm -f manifest.json' EXIT

if ! command -v node >/dev/null 2>&1; then
    echo "Error: node is not installed. Please install Node.js first." >&2
    echo "On macOS you can use: brew install node" >&2
    exit 1
fi

if ! command -v web-ext >/dev/null 2>&1; then
    echo "Error: web-ext is not installed." >&2
    echo "Install it globally with: npm install --global web-ext" >&2
    exit 1
fi

cd "$(dirname "$0")"

# NOTE: Keep this list in sync with the equivalent list in build.bat.
# When you add or remove an entry here, update build.bat as well.
# Not part of the extension: the debug mirrors, dev scripts, the common submodule's
# tooling and docs, and the Photoshop sources of the icons and store images.
IGNORE=(
    "debug/**" "scripts/**" ".github/**" "common/scripts/**" "common/README.md"
    "**/*.psd" "eslint.config.js" "package.json" "package-lock.json"
    "common/eslint.*" "common/package.json" "common/package-lock.json"
)

# Stop unless common/ is exactly the pinned commit, and that matches common's main.
# The check lives in the submodule, so check it out first if it never was.
[ -e common/.git ] || git submodule update --init common
node common/scripts/check-common.js
node common/scripts/build-i18n.js --check

echo "Building dataclasses..."
node scripts/build-dataclasses.js

build_variant() {
    local variant="$1" manifest="manifest_${1}.json"
    [ -f "$manifest" ] || return 0
    echo "Starting ${variant} build..."
    cp "$manifest" manifest.json
    web-ext build --filename "{name}-{version}-${variant}.zip" -o --ignore-files "${IGNORE[@]}"
    rm -f manifest.json
    echo "${variant} build complete."
}

build_variant chrome
build_variant firefox
build_variant electron

echo "All builds completed."
