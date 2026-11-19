#!/usr/bin/env bash
set -euo pipefail
image=$1
work=$(mktemp -d)
mount="$work/volume"
mkdir "$mount"
trap 'if mountpoint_active; then hdiutil detach -quiet "$mount"; fi; rm -rf "$work"' EXIT
mountpoint_active() { test -d "$mount/Morka.app"; }
hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mount" "$image"
test "$(readlink "$mount/Applications")" = /Applications
bundle="$work/Morka.app"
ditto "$mount/Morka.app" "$bundle"
hdiutil detach -quiet "$mount"
test -s "$bundle/Contents/Resources/LICENSE.electron.txt"
test -s "$bundle/Contents/Resources/LICENSES.chromium.html"
codesign --verify --deep --strict "$bundle"
node test/desktop-download.mjs "$bundle/Contents/MacOS/Morka" "$bundle/Contents/Resources"
