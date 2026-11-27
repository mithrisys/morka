#!/usr/bin/env bash
set -euo pipefail
image=$1
work=$(mktemp -d)
mount="$work/volume"
mkdir "$mount"
mounted=0
trap 'if [ "$mounted" -eq 1 ]; then hdiutil detach -quiet "$mount"; fi; rm -rf "$work"' EXIT
hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mount" "$image"
mounted=1
test "$(readlink "$mount/Applications")" = /Applications
set -- "$mount"/Morka*.app
test "$#" -eq 1 && test -d "$1"
bundle="$work/${1##*/}"
ditto "$1" "$bundle"
hdiutil detach -quiet "$mount"
mounted=0
test -s "$bundle/Contents/Resources/LICENSE.electron.txt"
test -s "$bundle/Contents/Resources/LICENSES.chromium.html"
codesign --verify --deep --strict "$bundle"
node test/desktop-download.mjs "$bundle/Contents/MacOS/Morka" "$bundle/Contents/Resources"
