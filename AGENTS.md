# Developing Morka

Morka creates, runs, and edits independent Node apps. Keep host capabilities, the starter template, and built-in skills reusable across projects. Put domain logic, integrations, and API credentials in the app that owns them. Use English for source, UI copy, documentation, and commit messages.

## Start here

- Before editing, run `git status --short --branch`. Create a focused branch from the latest available `main`, or continue on the branch for the same task. Preserve unrelated work.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for branch names, Conventional Commits, test-driven development, pull requests, and versioning.
- [Architecture](docs/architecture.md) explains the boundaries between the desktop host, the app runtime, and agent workspaces.

| Area | Entry points |
| --- | --- |
| Desktop and preview | `host/electron/main.ts`, `host/electron/preload.ts`, `host/renderer/`, `host/project/live-preview.ts` |
| Project contract and releases | `host/project/project.ts`, `host/project/drafts.ts`, `host/project/managed-runtime.ts`, `host/project/packages.ts` |
| Agents and app actions | `host/agents/sessions.ts`, `host/agents/registry.ts`, `host/agent-actions/` |
| Generated apps and packages | `host/app-runtime/starter/`, `host/skills/`, `host/instances/`, `packages/`, `scripts/` |

## Keep these boundaries intact

- Keep published app source, editable drafts, private user data, and generated releases separate. Build and check updates before publishing source. Verify that a failed update preserves both the last working release and the draft.
- Use IPC declared in `host/electron/ipc.d.ts` and exposed by `host/electron/preload.ts`. Validate the sender and input in the main process. Scope app requests to the active preview origin.
- Execute app-defined AI actions with a registered skill and validated JSON input and output. Keep provider credentials in the host. An app backend owns its data fetching and passes only the needed data to the action.
- Keep changes to generated app contracts in sync across the manifest parser, starter, built-in skills, and README. For npm kit changes, check both package manifests and the generated checkout lockfile.
- Use temporary directories and synthetic data for tests. Keep builds, dependencies, credentials, private settings, and app data out of Git.

## Verify changes

For a behavior change, first run a test that fails for the expected reason. Exercise the real user path when a change crosses the desktop, runtime, or packaging boundary. Update the relevant built-in skill in the same change when its instructions or examples would lead an app author astray.

Run `npm run typecheck` for TypeScript changes. On macOS, `npm test` builds the host and runs the main suite.

| Change | Focused checks after building |
| --- | --- |
| Chat history or draft publication | `node --test test/draft-sync.test.cjs` |
| App releases, package isolation, or action validation | `node --test test/npm-apps.test.cjs` |
| Window startup, retry, or active preview origin | `node --test test/runtime-lifecycle.test.cjs` |
| Generated checkouts or CLI entry points | `node --test test/portable.test.cjs` |
| Preview state or desktop installation | `npm run test:electron` on macOS |
| macOS packaging or the bundled toolchain | `npm run test:package:mac` on macOS |

Before handing off, review the diff against the base, run `npm run check:history` on the committed branch, run the relevant checks above, and report the behavior verified and any checks still pending. Keep each step in a focused, passing commit.
