# Morka architecture

Morka has a desktop host and an independent Node app for each project. The project repository contains an outer npm launcher and an editable `app/` directory. Agent drafts are scoped to `app/`. The checkout's chat history, account permissions, and app data live in its private profile.

## Desktop host and app

[`host/electron/main.ts`](../host/electron/main.ts) owns the launcher, windows, IPC, and agent connections. [The renderer](../host/renderer/) manages chat and embeds the running app. The app serves its UI and backend over a local HTTP origin. [The runtime proxy](../host/project/app-proxy.ts) keeps that origin stable as the server behind it changes.

An app opts into AI actions in `morka.project.json` and loads the host bridge from `/__morka/bridge.js`. The main process verifies the preview origin before forwarding actions. [The action runner](../host/agent-actions/runner.ts) validates input, runs a registered skill in a temporary provider session, and validates the structured result. The app backend owns external requests and supplies the data needed by the action.

## Edits and releases

1. [The chat session](../host/agents/sessions.ts) prepares a draft and gives the selected provider the applicable project instructions and file inventory.
2. [The package manager](../host/project/packages.ts) resolves dependencies and builds in staging. It produces an immutable artifact keyed by source, lockfile, toolchain, and build configuration.
3. [The managed runtime](../host/project/managed-runtime.ts) starts the candidate, checks health, and switches the stable proxy. [The live preview](../host/project/live-preview.ts) checks the page and restores UI state. Morka publishes the source after validation.
4. On failure, Morka preserves the working release and the agent's draft. App databases and files stay in the private data directory throughout the update.

Shadows package reusable project instructions, skills, and optional assets. Their installation metadata lets Morka reverse source edits it can safely attribute to the installation. [Shadow source and removal](../host/project/shadow-effects.ts)

## Packaging

The root npm package builds the host. [The npm kit](../scripts/npm-kit.mts) packs the runtime and packager CLIs for distribution. New checkouts use the registry lockfile from [the project template](../packages/project-template/package.json) to install published versions. The [desktop runtime registry](../host/instances/desktop-runtimes.ts) points to one native installation per version and architecture and exposes the newest registered runtime to lightweight launchers. A project records a minimum `runtimeVersion` and a separate `runtimeApi`. The host checks both against the runtime's bundled compatibility declaration before opening the project. [macOS distribution](../host/instances/distribution.ts) exports an independent app with a resolved compatible runtime and its prepared dependencies.

On macOS, the shared runtime prepares a signed, project-named bundle in the local profile cache so the system menu and About panel use the project's native identity. The cache reuses the same bundle for an unchanged runtime build and uses copy-on-write where the filesystem supports it. The runtime registry continues to track the shared installation.

[Runtime API upgrades](../host/instances/runtime-upgrades.ts) use a catalogue bundled with the host. The host applies known transformations in a persistent app draft and invokes [the migration skill](../host/skills/morka-runtime-migration/SKILL.md) for project-specific edits. The managed runtime validates the candidate before publishing source and compatibility metadata. The project keeps the same private profile across the upgrade.
