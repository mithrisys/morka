# Morka

Morka is an Electron app for building and running projects with Codex, Claude Code, and ACP agents. The `host/` directory contains the Morka host. The Chat icon opens the chat panel. The brain icon at the top of the window turns green while an agent is running.

For development setup and checks, see [Contributing](CONTRIBUTING.md).

## Create and open projects

To launch Morka from source on macOS, Windows, or Linux, install Node.js 24 or later and npm. Run these commands from the Morka repository root.

```sh
npm ci
npm start
```

Create an app in Morka and choose its parent directory. Morka creates a Git repository and opens the app from that source. **Open Project** opens an existing repository. **Clone** copies the app source into a new repository. App data, chats, and AI access permissions live in the user's private data directory, with separate local data for each checkout.

Morka installs a new project for the current user when it creates the project. To install from source, run `npm run install:app` from the project repository root with Node.js 24 or later. The installer installs the dependencies in the lockfile when needed. The app appears in `~/Applications` on macOS, the Start menu on Windows, and the application menu on Linux. Launching from the system menu, using **Open Project**, and running `npm start` use the same data and chats for the same checkout.

The app source and `morka.project.json` live in `app/`. Agent drafts are created from that directory, and edits are applied there. The repository root holds the Morka tooling's npm files, the README, release settings, and Git metadata. Each app has its own `package.json` and `package-lock.json` in `app/`, where agents can edit the app's dependencies.

Run the app from its repository root. Use the build command to generate a local launcher script.

```sh
npm ci
npm start
npm run build
```

`npm ci` installs the exact versions of `@morkaai/runtime` and `@morkaai/packager` from npm. Electron downloads its binary for the current platform. Commit the lockfile and `.morka/` with the source. `npm run build` writes a `.command`, `.cmd`, or `.sh` script to `dist/`. The script opens the same checkout and requires a local installation of Node.js and npm. Run projects you trust.

On macOS, run `npm run package:mac` from an app repository to create a self-contained local build under `dist/`.

Open **AI setup** to check whether Codex and Claude Code are installed and signed in. After installing or signing in through a terminal, click **Check again**. The first AI action in a new checkout asks for permission to use the local account. Morka stores the permission on that machine. You can reset it from **AI setup**.

Set `CODEX_BIN` or `CLAUDE_BIN` if you need to specify a CLI path.

## Project contract

Morka reads `morka.project.json` from the app source directory. The manifest selects the runtime and can register project rules and agent actions.

```json
{
  "version": 1,
  "runtime": { "type": "node", "script": "start" },
  "agentActions": { "definitions": "agents.json", "skills": "skills" },
  "instructions": ["conventions/ui.md"]
}
```

`runtime` is required. `agentActions` and `instructions` are optional. The latter lists rules and skills Morka passes to the editing agent. Update the manifest paths when you move these files.

Each chat has a persistent history and its own draft. Morka applies validated edits to the project. Drafts exclude `.env` files, installed dependencies, agent settings directories, and database files. Each draft is limited to 4,000 files and 96 MB.

When the app source changes outside Morka, a draft with no independent edits follows the current source. If the draft also contains unpublished edits, Morka preserves it and lists the files that need reconciliation.

## Agents and chat sessions

Use the agent picker beside the message field to choose the agent for the next message. Responses appear in the same chat history with the agent's name. Click **Stop agent** to stop the current turn. Morka gives the selected agent the draft and the active project rules.

| Agent | Session and setup |
| --- | --- |
| Codex | `codex app-server` with a native session that resumes using the same ID |
| Claude Code | `claude --print`, sign-in with `claude auth login`, and replay of the Morka chat history |
| Hermes | `hermes acp` on macOS with profile-specific settings and sign-in |
| Pi | The `pi-acp` adapter CLI on macOS with profile-specific settings and sign-in |

The active agent connection supplies the **Model** and **Effort** options. If it provides no model list, it uses its own default model. An ACP v1 connection negotiates capabilities and resumes the native session when supported. Otherwise, it passes Morka's chat history to a new session. On macOS, the ACP process can write to the draft and its private agent data directory. ACP file requests are scoped to the draft.

Morka reads ACP agent commands and arguments from `acp-profiles.json` in its data directory. Set `MORKA_ACP_PROFILES` to use an absolute path to another profiles file. You can also set `HERMES_BIN` or `PI_ACP_BIN`.

```json
[
  {
    "id": "my-agent",
    "name": "My ACP Agent",
    "command": "/opt/homebrew/bin/my-agent",
    "args": ["acp"],
    "readPaths": ["/opt/homebrew/share/my-agent"]
  }
]
```

`readPaths` lists the installation paths the agent needs to read. Morka passes API environment variables for common services to the agent. On macOS, launcher and app data are stored in `~/Library/Application Support/Morka Apps/`.

For profile-specific sign-in, open `agents/<id>/home/` under the active app's data directory. Put Hermes settings in `.hermes/` and Pi settings in `.pi/agent/` under that directory. Morka copies the Hermes settings into the separate model-discovery environment and each draft environment. Each Gateway runs with the access granted to its own environment. The first run in a Hermes environment may take longer while it prepares dependencies.

```sh
morka_data="/path/to/active/app/data"
HERMES_HOME="$morka_data/agents/hermes/home/.hermes" hermes acp --setup
PI_CODING_AGENT_DIR="$morka_data/agents/pi/home/.pi/agent" pi
```

In an action definition, set `provider` to `codex` or `claude`, or let the user choose by leaving it unset. Both providers return structured output. ACP is available for project chat in this version.

## Plugin Shadow

Click **Shadows** in the toolbar to see the IDs and versions of installed Shadows. **New Shadow** creates a separate Git repository and opens a dedicated chat window. **Open Shadow** reopens the repository and its chat history. A Shadow agent edits files in `shadow/` only. Run `npm ci`, `npm run validate`, and `npm run pack` from the repository root to create an installable directory in `dist/`.

Use **Install Shadow** to select either a Shadow repository or a packaged output directory. The installable package includes a root `manifest.json` listing its contents.

```json
{
  "id": "ui-conventions",
  "version": "1.0.0",
  "description": "Shared interface conventions",
  "skills": "skills/ui-conventions/SKILL.md",
  "rules": "rules/ui.md",
  "assets": ["media/palette.svg"],
  "examples": ["examples/component.css"]
}
```

Morka stores the package version and change history for new installations in `app/.morka-shadows/`. The `shadows` entries in the app manifest record each Shadow's ID, version, fingerprint, and paths to its active skill and rules. To apply updates from a Shadow repository, select the new version through **Install Shadow**.

Use **Remove** to uninstall a Shadow. You can keep its previous edits or revert the effects Morka can reliably identify. The confirmation dialog lists the proposed changes and the files that will be kept because of later edits or dependencies.

Morka registers the rules and skill during installation. Editing agents receive active rules on later turns, including in new chats. Example files serve as references during installation.

## npm dependencies and prepared releases

New apps use the managed Node runtime. This minimal configuration goes in `app/morka.project.json`.

```json
{"version":1,"runtime":{"type":"node","script":"start"}}
```

To enable agent actions in a Node app, add `agentActions: {"definitions":"agents.json","skills":"skills"}` to the manifest and load `/__morka/bridge.js` in the HTML from the same origin. `window.morka.runAgentAction` uses this bridge to call the host connection. Host IPC and credentials stay in the host. Implement search, feeds, and other external integrations in the app's backend. When the feature needs AI, pass the relevant data to the action as JSON input.

`app/package.json` must define a `start` script for the production server. The server listens on `process.env.HOST` and `Number(process.env.PORT)` and serves `/health` without side effects. `runtime.ready` can specify a different URL on the same origin as the manifest's runtime URL. Port zero in the manifest requests an assigned internal port. `runtime.url` is optional. If it specifies a nonzero port, the proxy uses that port as its fixed loopback port.

When you run a project through npm, Morka uses the locally installed Node and npm. Native modules are installed and run against that Node ABI, independently of Electron's ABI. Packages without a compatible prebuilt binary may need a compiler or system library. Self-contained macOS releases use their bundled toolchain.

When an edit in chat changes `package.json` or the lockfile, Morka prepares a release in staging. It updates the lockfile if needed, runs `npm ci --include=dev`, runs `build` and `morka:check` when defined, and prunes dev dependencies. Morka stores the result in `runtime/<app-id>/releases/<hash>/`, keyed by source fingerprint, lockfile, Node version, architecture, and operating system. It retains the five most recent releases, active releases, and releases still needed by running processes. Cleanup leaves the data directory intact. Each app and release has its own `node_modules`. Each app has a separate npm download cache. Files created in the installation-stage home directory ship with the release. At startup, Morka copies any missing files into the app's private home and preserves existing user settings.

On macOS, installation and build scripts run in a sandbox. They can write to the app's staging directory and cache and read the required tools, SDK, and app-specific npm settings. The sandbox blocks access to the original source, user data, host home directory, and agent settings. Local dependencies must live inside `app/`. npm supports public registries, private registries, and Git dependencies. Store private registry settings in `runtime/<app-id>/npm/npmrc`. The `npm.env` and `build.env` files in that directory supply explicit variables for installation and builds. Keep credentials out of source files and lockfiles.

On Windows and Linux, installation and builds run in a temporary directory with a private environment. These platforms have no OS-level sandbox for this step.

If installation or the build fails, Morka preserves the app source and running release and returns the failure to the agent for one repair attempt. A new Node release starts on a separate internal port. Once the server is healthy and pending writes have finished, Morka checks the page on the same origin. If the page fails to load or initialize, Morka restores the previous UI and AI actions and keeps the failed change and its error in the draft for repair. Morka publishes the source after validation succeeds. When you reopen the app, Morka starts from the last known good release. If the source changed outside Morka, **Retry** can check it again.

During the page check, the proxy holds back writes and new WebSocket connections to the candidate release. After activation, requests to the previous release drain and its process shuts down. After a full reload, the app must reestablish its WebSocket connection.

The new server starts with `MORKA_PHASE=prepare`. `globalThis.morkaRuntime.isActive()` tells the server whether it owns the active release. Listen for the `morka:activate` and `morka:retire` events on `process` to start and stop background work. Scheduled jobs should check active ownership and use a stable idempotency key. Keep startup and health checks free of destructive migrations and external messages.

Declare live schema migrations separately and give each one a stable ID.

```json
{"type":"node","migration":{"id":"add-column-v1","script":"migrate","compatibility":"backward-compatible"}}
```

The migration script must be transactional, idempotent, and compatible with both the old and new releases. Morka pauses new requests and waits for pending writes before running it. A successful migration ID runs once. Rolling back the code preserves current database contents. Incompatible schema changes require a separate migration plan.

The `.app` bundle includes Node and npm, source, build output, production dependencies, and the files needed for installation. On first launch, Morka imports the prepared release into the app's private directory. The app can then run offline without installing packages. Source edits in a distributed app follow the same preparation cycle.

## Run and update the app

Morka starts the service when the app opens and displays the UI after the readiness URL responds. Closing the app stops the service. If startup fails, Morka shows an error and a retry button.

For eligible linked stylesheets that require no build, Morka swaps the stylesheet without rebuilding the page or stopping the service. It preserves the stylesheet URL so relative image and font paths still work. CSS generated during a build goes live with the new release while Morka preserves UI state.

During code updates, Morka keeps the current path, query string, URL fragment, navigation history, form input, text selection, focus, and scroll position in memory and restores them after the new release loads. The current page stays visible until the service is ready. In-flight requests finish before the service stops. A selected file that has yet to be submitted delays the update.

Expose custom JavaScript state such as filters, active tabs, and form steps through `window.morkaLifecycle`. Set `ready` to a promise that resolves after initial loading. Implement `beforeUpdate()` to finish pending work, `capture()` to return JSON-serializable state, and `restore(state)` to restore it. Use this contract for state the DOM alone cannot restore. The app authoring skill also requires agents to preserve it. Keep state keys and control IDs stable when editing the app.

Node services receive a persistent data path through `process.env.MORKA_DATA_DIR`, outside the source tree and agent draft. Source snapshots and published edits exclude SQLite and other database files, their WAL, journal, and shm files, and the `.morka-data/` directory. Store business data in persistent storage and preserve it when changing the UI.

## License

Morka is distributed under the [MIT License](LICENSE). Bundled third-party components retain their own licenses.
