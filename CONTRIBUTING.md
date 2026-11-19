# Contributing to Morka

Use Node.js 24 or later with npm. Run these commands from the repository root.

```sh
npm ci
npm start
```

The launcher builds and runs the desktop host from source. You can build without opening Electron using `npm run build -- --portable`. The build writes the host and local npm kit to `dist/`.

The root package is the private development entry point. The build packs `@morka/runtime` and `@morka/packager` from their manifests in `packages/` into `dist/npm/`. Keep both package versions and the runtime dependency pins in sync with the root package.

See the [architecture overview](docs/architecture.md) before changing the project runtime, IPC, or generated packages. [AGENTS.md](AGENTS.md) maps common changes to their focused checks.

## Checks

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check the TypeScript host and renderer. |
| `npm test` | Build and run the main suite. Run the full suite on macOS. |
| `npm run test:apps` | Rerun the main suite against the current build. |
| `npm run test:package:mac` | Verify signed macOS packaging and offline startup after a full build. |
| `npm run test:electron` | Exercise the macOS installer and live preview in Electron after a full build. |

Run individual suites with `node --test test/<name>.test.cjs` after building. Runtime tests use temporary workspaces and loopback servers. macOS integration checks require access to the system sandbox and Xcode Command Line Tools.

## Pull requests

Keep each change focused. Include the motivation, user-visible effects, and the checks you ran. When a change affects new app repositories, build the npm kit and verify the generated app path. Keep sample data synthetic and omit credentials, private app data, and generated bundles from the diff.
