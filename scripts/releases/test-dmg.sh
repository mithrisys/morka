#!/usr/bin/env bash
set -euo pipefail
image=$1
mount=$(mktemp -d)
hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mount" "$image"
trap 'hdiutil detach -quiet "$mount"; rmdir "$mount"' EXIT
test "$(readlink "$mount/Applications")" = /Applications
bundle="$mount/Morka.app"
codesign --verify --deep --strict "$bundle"
node test/desktop-download.mjs "$bundle/Contents/MacOS/Morka" "$bundle/Contents/Resources"
