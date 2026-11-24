#!/usr/bin/env bash
set -euo pipefail

root=${1%/}
entry="$root/usr/share/applications/morka.desktop"
if ! test -f "$entry" || ! test -r "$entry" || ! test "$(stat -c '%a' "$entry")" = 644; then
  echo "The Morka desktop entry must be readable by all desktop users: $entry" >&2
  exit 1
fi

icon=$(sed -n 's/^Icon=//p' "$entry")
if [[ "$icon" != /* ]] || ! test -r "$root$icon" || ! test -n "$(find "$root$icon" -type f -perm -044 -print -quit)"; then
  echo "The Morka desktop entry must reference a readable bundled icon: $icon" >&2
  exit 1
fi
