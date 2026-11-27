# Changelog

Release entries describe user-visible changes and upgrade steps, newest first.

## 0.3.0-beta.5 (2026-11-27)

Open an existing app from a folder, a ZIP or TAR.GZ archive, or a Git URL using **or wake up a morka…** in the launcher. Project shortcuts share the installed desktop runtime, and Morka can guide a project through a runtime API upgrade. On macOS, the project window, menu, and About panel use the app’s own name.

The new quickstart walks you through building a personal desktop app with your existing Codex or Claude Code subscription. Try an AI feature on a meeting note, then change the layout while the note stays open.

### Installation

Choose the download for your operating system and architecture below. Open an existing project once from the Morka launcher to refresh an older shortcut. The macOS build uses an ad-hoc signature and lacks Apple notarization. The README covers first launch on macOS. The Windows installer lacks a publisher signature.

[Full changelog](https://github.com/mithrisys/morka/compare/v0.3.0-beta.4...v0.3.0-beta.5)

## 0.3.0-beta.4 (2026-11-24)

Linux now has DEB and RPM installers for x64 and ARM64 alongside the portable archives. The installers add Morka to the application menu with its own icon. On Ubuntu 24.04 and newer, the DEB sets up the AppArmor profile for Electron's sandbox.

On Windows, Morka uses its own executable icon and hides Electron's default menu. Creating a project from the Windows or Linux desktop app uses the bundled runtime, so it no longer needs to download a separate Electron. Windows projects can live on shared folders and open from their Start menu shortcuts.

### Upgrading

Quit Morka and install the download for your platform and architecture. Use `sudo apt install ./morka-*.deb` on Debian or Ubuntu, or `sudo dnf install ./morka-*.rpm` on Fedora. You can open existing projects from their folders. To update an existing npm checkout, pin both `@morkaai/runtime` and `@morkaai/packager` to `0.3.0-beta.4` and commit the updated lockfile.

### Known limitations

The macOS download uses an ad-hoc signature. The Windows installer lacks an Authenticode publisher signature. The release workflow installs and tests the DEB on Ubuntu, and checks the RPM by extracting and running it on Ubuntu. Native Fedora installation has yet to be verified.

[Full changelog](https://github.com/mithrisys/morka/compare/v0.3.0-beta.3...v0.3.0-beta.4)

## 0.3.0-beta.3 (2026-11-24)

Morka now ships native ARM64 desktop downloads for Windows and Linux alongside the x64 downloads. Each includes Node.js, npm and Electron for its architecture.

New projects include accessible form and layout styles and fast Node test scripts. Editing agents can consult focused guidance for UI design, engineering, runtime services and AI actions while following each project’s conventions. Desktop downloads pin new project checkouts to the version of the runtime and packager published with this beta.

### Workflow review

Add a preview scenario or type `/review` in app chat to check a workflow with synthetic data at two window sizes. Image-capable providers can inspect temporary screenshots. The first scenario is checked before activation. Later watched edits can be reviewed and repaired in the background. Starting another edit cancels the previous review. Direct linked CSS changes preserve the live document and input.

### Upgrading

Existing apps can add a preview scenario when needed. To use this beta in an existing npm checkout, install the runtime and packager at the exact version `0.3.0-beta.3` together after publication. Commit both dependency declarations and the updated lockfile.

### Known limitations

Browser scenarios use prepared frontend assets and synthetic API responses. Server behavior belongs in app tests. The macOS download uses an ad-hoc signature. The Windows installer lacks an Authenticode publisher signature.

[Full changelog](https://github.com/mithrisys/morka/compare/v0.3.0-beta.2...v0.3.0-beta.3)

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
