#!/usr/bin/env bash
set -euo pipefail

# Exercise the release step with the same directory layout as download-artifact.
root=$(pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export RUNNER_TEMP="$work" npm_config_cache="$work/cache" GIT_ALLOW_PROTOCOL=file
export RELEASE_TAG="v$(node -p "require('./package.json').version")"
ruby -ryaml -e 'puts YAML.load_file(ARGV[0]).fetch("jobs").fetch("publish").fetch("steps").last.fetch("run")' \
  .github/workflows/release.yml > "$work/publish.sh"
cd "$work"
mkdir release
ln -s "$root/dist/archives" release/canonical-kit

# Simulate a missing registry version, then read back what npm would publish.
curl() { printf '404'; }
npm() {
  case "$1" in
    publish) command npm "$@" --dry-run --offline --ignore-scripts --json > "$component.json" ;;
    view) jq -er --arg name "$name" '(.[$name] // .).integrity' "$component.json" ;;
    *) return 1 ;;
  esac
}
source ./publish.sh
for component in runtime packager; do
  name="@morkaai/$component"
  jq -e --arg name "$name" --arg version "${RELEASE_TAG#v}" \
    '(.[$name] // .) | .name == $name and .version == $version' "$component.json" > /dev/null
done

# Exercise the real release steps against a local GitHub CLI double.
mkdir downloads metadata
for suffix in macOS-arm64.dmg Windows-{x64,arm64}-Setup.exe Linux-{x64,arm64}.{tar.gz,deb,rpm}; do
  printf '%s' "$suffix" > "downloads/morka-${RELEASE_TAG#v}-$suffix"
done
(cd "$root" && node scripts/releases/metadata.mjs "$work/downloads" "$work/metadata/release-notes.md")
mv downloads/SHA256SUMS.txt metadata/
for job in draft publish-release; do
  ruby -ryaml -e 'puts YAML.load_file(ARGV[0]).fetch("jobs").fetch(ARGV[1]).fetch("steps").last.fetch("run")' \
    "$root/.github/workflows/release.yml" "$job" > "$job.sh"
done

gh() {
  test "$1" = release && test "$3" = "$RELEASE_TAG" || return 1
  echo "$2" >> calls
  case "$2" in
    view)
      test -f draft-state || return 1
      if [[ "$*" == *"--jq .isDraft"* ]]; then cat draft-state; else jq -n --argjson draft "$(cat draft-state)" '{isDraft: $draft}'; fi ;;
    create) test ! -f draft-state && [[ "$*" == *"--verify-tag --draft"* ]] && echo true > draft-state ;;
    upload) test "$(cat draft-state)" = true && test "$#" -eq 16 ;;
    edit) if [[ "$*" == *"--draft=false"* ]]; then echo false > draft-state; fi ;;
    *) return 1 ;;
  esac
}
(source draft.sh)
(source draft.sh)
(source publish-release.sh)
(source draft.sh)
test "$(cat draft-state)" = false
test "$(grep -c '^create$' calls)" = 1
test "$(grep -c '^upload$' calls)" = 2
