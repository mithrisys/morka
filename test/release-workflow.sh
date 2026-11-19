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
ln -s "$root/dist/archives" packages

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
