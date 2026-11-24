# Contributing to Morka

Use Node.js 24 or later with npm. Run these commands from the repository root.

```sh
npm ci
npm start
```

The launcher builds and runs the desktop host from source. You can build without opening Electron using `npm run build -- --portable`. The build writes the host and local npm kit to `dist/`.

The root package is the private development entry point. The build packs `@morkaai/runtime` and `@morkaai/packager` from their manifests in `packages/` into `dist/archives/`. Keep both package versions and the runtime dependency pins in sync with the root package.

See the [architecture overview](docs/architecture.md) before changing the project runtime, IPC, or generated packages. [AGENTS.md](AGENTS.md) maps common changes to their focused checks.

## Branches and commits

Start each independent change on a short-lived branch from the latest available `main`. Check `git status --short --branch` before editing. Continue related work on its existing branch. Preserve other contributors' uncommitted changes. For example, start a new documentation change with `git switch -c docs/development-workflow main` from a clean checkout.

Use `<type>/<short-kebab-case-description>` for branches. An existing issue number may prefix the description, as in `fix/42-preview-state-after-reload`. Use one of `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, or `revert` for branch and commit types. The branch describes the overall change. Individual commits describe each step.

Write Conventional Commit subjects in English using `<type>(<optional-scope>): <imperative summary>`. Omit the parentheses when there is no scope. Use a recognizable project area such as `runtime`, `desktop`, `agents`, or `packager`. Mark a breaking contract change with `!` before the colon and explain the impact and upgrade steps in a `BREAKING CHANGE:` footer.

```text
feat(runtime): add timeouts for app actions
fix(desktop): preserve preview state after reload
test(packager): verify offline startup of packaged apps
```

Keep each commit buildable, focused, and independently understandable. Include the reason in the body when the diff cannot explain it. Fold fixups into the relevant commits before review.

## Test-driven development

For a feature, describe an observable result and write a failing test at the lowest level that can prove it. For a bug, reproduce it through the affected entry point first. Run the test and confirm the failure identifies the missing behavior. Implement the change, rerun the test, then refactor while it stays green. Commit the regression test with its fix.

Use a unit test for isolated validation or transformations and an integration test for contracts between components. Extend end-to-end coverage when a change affects an essential user journey. For example, test preview state across a reload in Electron, and test offline startup against a packaged app. When changing draft publication, cover both the working release and the editable draft after a failed update. Use temporary workspaces, synthetic data, and local services so tests run independently of accounts and live providers.

For documentation-only changes, check links, commands, and examples. For a change to generated app repositories, build the npm kit and exercise the generated app.

## Checks

| Command | Purpose |
| --- | --- |
| `npm run check:history` | Check the local topic branch name and the subjects of every commit it introduces relative to `main`. |
| `npm run check:versions` | Verify that package versions, the runtime peer pin, and the root lockfile agree. |
| `npm run test:workflow` | Exercise the workflow checks against temporary Git repositories and package manifests. |
| `npm run typecheck` | Check the TypeScript host and renderer. |
| `npm test` | Build and run the app suite on Linux, Windows, or macOS. |
| `npm run test:apps` | Rerun the main suite against the current build. |
| `npm run test:package:mac` | Verify signed macOS packaging and offline startup after a full build. |
| `npm run test:preview` | Exercise live preview in Electron on all three platforms. On a headless Linux runner use `xvfb-run -a npm run test:preview`. |
| `npm run test:install:mac` | Exercise the signed macOS installer in Electron after a full build. |

Run individual suites with `node --test test/<name>.test.cjs` after building. Runtime tests use temporary workspaces and loopback servers. The package lifecycle sandbox and bundled native-addon tests require macOS and Xcode Command Line Tools. On Linux and Windows the shared runtime tests use the local Node.js and npm installation.

## Pull requests

Submit one independently reviewable change per pull request. Describe the motivation, observable behavior, and checks run. Identify any checks that still need a platform runner. Keep credentials, private app data, and generated bundles out of the diff.

Integrate through pull requests using rebase and merge to preserve the reviewed commits. On GitHub, protect `main` by requiring a pull request and the `Development workflow`, `Test on Linux`, `Test on Windows`, and `Test on macOS` checks to pass. A second reviewer is optional for a sole maintainer.

## Versions and releases

The desktop host, `@morkaai/runtime`, and `@morkaai/packager` share a Semantic Version. The CLI, app manifest, and runtime interfaces consumed by apps are public contracts. Use the highest applicable increment for the release.

| Change | Increment |
| --- | --- |
| Compatible fix | Patch |
| Compatible feature | Minor |
| Breaking public contract before 1.0 | Minor, with upgrade notes |
| Breaking public contract from 1.0 onward | Major, with upgrade notes |

Documentation, CI, and internal refactoring alone do not require a release. Collect changes in a dedicated release PR. Update the three manifests, the packager's exact runtime peer dependency, and the root lockfile together. Add a dated entry to [CHANGELOG.md](CHANGELOG.md) describing user-visible changes and any upgrade steps. After the release PR lands and its push CI run on `main` passes, tag that commit as `v<version>`, for example `v0.3.0`, and push the tag. Write the entry in English under `## <version> (YYYY-MM-DD)`. Lead with the change users will notice. Include fixes, upgrade steps and known limitations when they apply. Use third-level headings within a release. Where a previous tag exists, add a Full changelog link to the GitHub comparison. The GitHub Release takes its body from that exact entry. Missing, empty or duplicate entries fail verification.

The [release workflow](.github/workflows/release.yml) builds the npm packages and nine native desktop downloads from the verified tag. Ubuntu 22.04 runners build Linux tarballs, DEBs, and RPMs for x64 and ARM64. Windows uses per-user NSIS installers for x64 and ARM64. The macOS disk image targets Apple Silicon. Each runner mounts, installs or extracts its downloads, verifies the bundled Node and Electron architecture, and runs a fresh starter with the bundled Node and npm. Run `npm run package:desktop` on the corresponding architecture to build the downloads in `release/downloads/`. Install `rpm` and `cpio` to build and inspect RPM packages on Ubuntu.

For tagged builds, the prepare job resolves the starter lockfile against the exact npm archives selected for publication. Native desktop downloads embed the same registry pins and integrity hashes. Release jobs transfer the kit and tested downloads through GitHub Actions caches keyed to that run and attempt.

After all native tests pass, the workflow stages the downloads and `SHA256SUMS.txt` in a draft GitHub Release. It publishes and verifies the runtime followed by the packager using npm Trusted Publishing, then makes the GitHub Release public. A prerelease version such as `0.3.0-beta.1` is marked as a GitHub prerelease and uses the npm `next` tag. Stable versions use `latest`. Pull requests build and test the downloads with read-only permissions. Release runs assemble the release metadata and upload the downloads to GitHub Releases.

The macOS build currently uses an ad-hoc signature. The Windows installer has no publisher signature. Record these limitations in release notes for preview builds. Plan Developer ID signing and notarization on macOS and Authenticode signing on Windows before broad distribution.

To retry a tag that includes the desktop packaging scripts after a workflow fix, run **Release Morka** from `main` in GitHub Actions and enter the existing tag. The workflow builds that tag's commit and checks its successful push CI run on `main` before publishing.

Configure npm Trusted Publishing for both packages with the GitHub repository `mithrisys/morka`, workflow filename `release.yml`, and direct publish permission. Only the publish job requests an OIDC token. After both packages are available, update the two exact versions in `packages/project-template/package.json` and run `npm install --package-lock-only --ignore-scripts` in that directory. Commit its lockfile to promote the release to new projects. The first publication of version `0.2.1` uses an authenticated npm session.

## Maintaining agent guidance

Keep repository development instructions in [AGENTS.md](AGENTS.md) and this guide. Claude and Copilot use the same instructions. Keep app-author guidance in the [built-in skills](host/skills/). If a contract or workflow changes, update the affected instructions and verify their example against the current implementation in the same PR.

When an agent repeatedly makes the same mistake, find the instruction or example that led to it, make a targeted correction, and exercise the corrected path. Keep domain-specific integrations in the app that owns them.
