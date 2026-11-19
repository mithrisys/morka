# Changelog

Release entries describe user-visible changes and upgrade steps, newest first.

## 0.3.0-beta.2 (2026-11-20)

The desktop launcher responds to both project actions again. Swipe right to name a new project and choose its folder, or select **Open Project** to browse for an existing one.

### Upgrading

Quit Morka and replace the beta.1 desktop app with the download for your platform. You can open your existing project folder directly. To test the npm prerelease, use `@morkaai/runtime@0.3.0-beta.2` and `@morkaai/packager@0.3.0-beta.2` together.

### Known limitations

The macOS app uses an ad-hoc signature and lacks Apple notarization. The Windows installer lacks an Authenticode publisher signature. Both systems may display a warning when opening the download.

[Full changelog](https://github.com/mithrisys/morka/compare/v0.3.0-beta.1...v0.3.0-beta.2)

## 0.3.0-beta.1 (2026-11-20)

This first desktop preview lets you install Morka and run a starter project with the included Node.js and npm. Choose the download for your platform and verify it against `SHA256SUMS.txt`.

### Downloads

- **macOS (Apple Silicon)** — Open the DMG and drag Morka into Applications.
- **Windows (x64)** — Run the setup executable to install Morka for your user account.
- **Linux (x64)** — Extract the tarball, then run `./morka/morka` in a graphical desktop session. The package was tested on Ubuntu 22.04.

### Project compatibility

The desktop installer now opens generated projects with their pinned runtime. New projects use the stable `0.2.2` runtime and packager. Developers testing the prerelease packages can install both at the exact version `0.3.0-beta.1` from npm.

### Known limitations

The macOS app is ad-hoc signed and has not been notarized by Apple. The Windows installer has no Authenticode publisher signature. Both systems may display a security warning when opening the download.

[Full changelog](https://github.com/mithrisys/morka/compare/v0.2.2...v0.3.0-beta.1)

## 0.2.2 (2026-11-19)

- New app and Shadow repositories install exact versions of the runtime and packager from npm. Their generated lockfiles record the registry URLs and integrity hashes, so the repositories no longer need to include package archives.
- To upgrade an existing app, install `@morkaai/runtime@0.2.2` as an exact dependency and `@morkaai/packager@0.2.2` as an exact development dependency. Commit the updated manifest and lockfile together.
